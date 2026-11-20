"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "./db";
import {
  audit,
  createSession,
  destroySession,
  getSession,
  requireSession,
  verifyPin,
} from "./auth";
import { parseDollarsToCents } from "./money";
import { checkRate, clearRate, recordFailure, pruneOldAttempts } from "./ratelimit";
import { headers } from "next/headers";
import { addDays, isYmd, longDate, todayYmd, ymdInBusinessTz } from "./dates";

export type ActionState = { error?: string; fieldErrors?: Record<string, string> };

// ---------------------------------------------------------------- login

// Eight wrong attempts inside ten minutes locks that source out for fifteen.
// Generous for a manager fumbling a store number, useless for a script working
// through a six-digit Company Admin PIN.
const LOGIN_LIMIT = { limit: 8, windowMs: 10 * 60_000, lockMs: 15 * 60_000 };

async function clientIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip") ?? "unknown";
}

export async function loginAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const code = String(formData.get("loginCode") ?? "").trim().toUpperCase();
  const pin = String(formData.get("pin") ?? "").trim();

  if (!code) return { error: "Enter your store number." };

  // Throttle by source address and by the code being tried, so neither a single
  // machine nor a distributed run at one account gets unlimited guesses.
  const ip = await clientIp();
  const ipKey = `login:ip:${ip}`;
  const codeKey = `login:code:${code}`;

  for (const key of [ipKey, codeKey]) {
    const verdict = await checkRate(key, LOGIN_LIMIT);
    if (!verdict.ok) {
      await audit({
        userId: null,
        userName: `blocked (${code})`,
        action: "LOGIN_BLOCKED",
        detail: { code, ip, retryAfterSeconds: verdict.retryAfterSeconds },
      });
      const mins = Math.ceil(verdict.retryAfterSeconds / 60);
      return {
        error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`,
      };
    }
  }

  const fail = async (message: string): Promise<ActionState> => {
    await recordFailure(ipKey);
    await recordFailure(codeKey);
    return { error: message };
  };

  let user = await prisma.user.findUnique({
    where: { loginCode: code },
    include: { store: true },
  });

  // Several store numbers begin with a zero, and they are not all the same
  // length ("02627" is five digits, "0013" is four). If someone types "2627"
  // or "13", widen the code a zero at a time rather than telling them their
  // own store number is wrong.
  if (!user && /^\d{1,5}$/.test(code)) {
    for (let len = code.length + 1; len <= 5 && !user; len++) {
      user = await prisma.user.findUnique({
        where: { loginCode: code.padStart(len, "0") },
        include: { store: true },
      });
    }
  }

  if (!user || !user.active) {
    await audit({
      userId: null,
      userName: `unknown (${code})`,
      action: "LOGIN_FAILED",
      detail: { code, ip },
    });
    return fail("That store number is not recognised.");
  }

  // Managers sign in with the store number alone. The Company Admin still needs
  // a PIN, because that account can see every store's numbers.
  if (user.pinHash) {
    if (!pin) return { error: "Enter your PIN." };
    if (!verifyPin(pin, user.pinHash)) {
      await audit({
        userId: user.id,
        userName: user.name,
        action: "LOGIN_FAILED",
        detail: { code, ip, reason: "bad pin" },
      });
      return fail("Store number or PIN is not correct.");
    }
  }

  await clearRate(ipKey);
  await clearRate(codeKey);
  // Opportunistic cleanup; cheap, and needs no scheduler.
  void pruneOldAttempts().catch(() => {});

  await createSession({
    userId: user.id,
    name: user.name,
    role: user.role as "MANAGER" | "OWNER",
    storeId: user.storeId,
    storeNumber: user.store?.storeNumber ?? null,
    storeName: user.store?.name ?? null,
  });
  await audit({ userId: user.id, userName: user.name, action: "LOGIN" });

  redirect(user.role === "OWNER" ? "/owner" : "/dashboard");
}

export async function logoutAction(): Promise<void> {
  const s = await getSession();
  if (s) await audit({ userId: s.userId, userName: s.name, action: "LOGOUT" });
  await destroySession();
  redirect("/login");
}

// ------------------------------------------------------------- deposits

const MAX_BACKDATE_DAYS = 45;

export async function createDepositAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  if (session.role !== "MANAGER" || !session.storeId) {
    return { error: "Only a store manager can file a deposit." };
  }
  const storeId = session.storeId;

  // ---- business date ----
  const businessDate = String(formData.get("businessDate") ?? "");
  if (!isYmd(businessDate)) return { error: "Pick a valid deposit date." };
  const today = todayYmd();
  if (businessDate > today) {
    return { error: "You cannot file a deposit for a future date." };
  }
  if (businessDate < addDays(today, -MAX_BACKDATE_DAYS)) {
    return {
      error: `That date is more than ${MAX_BACKDATE_DAYS} days ago. Ask the Company Admin to enter it.`,
    };
  }

  // ---- the amount ----
  const totalCents = parseDollarsToCents(String(formData.get("amount") ?? ""));
  if (totalCents === null) {
    return {
      error: "Enter the deposit amount in dollars and cents, e.g. 1450.75",
      fieldErrors: { amount: "Not a valid amount" },
    };
  }
  if (totalCents <= 0) return { error: "A deposit cannot be zero." };

  // ---- re-key confirmation: the manager types the amount again ----
  const confirmCents = parseDollarsToCents(String(formData.get("confirmTotal") ?? ""));
  if (confirmCents === null) {
    return {
      error: "Type the amount again to confirm it.",
      fieldErrors: { confirmTotal: "Required" },
    };
  }
  if (confirmCents !== totalCents) {
    return {
      error: "The two amounts do not match. Check the deposit slip before filing.",
      fieldErrors: { confirmTotal: "Does not match" },
    };
  }

  // ---- duplicate guard ----
  const existing = await prisma.deposit.findFirst({
    where: { storeId, businessDate, status: "ACTIVE" },
  });
  const acknowledgedExtra = formData.get("allowSecond") === "on";
  if (existing && !acknowledgedExtra) {
    return {
      error:
        "This date already has a deposit. Tick “additional deposit” if this is a second drop, or void the first one.",
    };
  }

  const deposit = await prisma.deposit.create({
    data: {
      storeId,
      businessDate,
      totalCents,
      bagNumber: String(formData.get("bagNumber") ?? "").trim() || null,
      note: String(formData.get("note") ?? "").trim() || null,
      enteredById: session.userId,
    },
  });

  await audit({
    userId: session.userId,
    userName: session.name,
    action: "DEPOSIT_CREATE",
    entity: "Deposit",
    entityId: deposit.id,
    detail: { storeId, businessDate, totalCents },
  });

  revalidatePath("/dashboard");
  revalidatePath("/owner");
  redirect(`/deposit/${deposit.id}?filed=1`);
}

export async function voidDepositAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const id = Number(formData.get("depositId"));
  const reason = String(formData.get("reason") ?? "").trim();

  if (!Number.isInteger(id)) return { error: "Bad deposit id." };
  if (reason.length < 5) return { error: "Give a reason (at least 5 characters)." };

  const deposit = await prisma.deposit.findUnique({ where: { id } });
  if (!deposit) return { error: "Deposit not found." };
  if (deposit.status === "VOIDED") return { error: "Already voided." };

  if (session.role === "MANAGER") {
    if (deposit.storeId !== session.storeId) {
      await audit({
        userId: session.userId,
        userName: session.name,
        action: "VIEW_DENIED",
        entity: "Deposit",
        entityId: id,
      });
      return { error: "Not your store." };
    }
    // A manager can only undo their own slip on the same day they entered it.
    if (ymdInBusinessTz(deposit.createdAt) !== todayYmd()) {
      return { error: "Past today, only the Company Admin can void a deposit. Call the office." };
    }
  }

  await prisma.deposit.update({
    where: { id },
    data: {
      status: "VOIDED",
      voidedById: session.userId,
      voidedAt: new Date(),
      voidReason: reason,
    },
  });

  await audit({
    userId: session.userId,
    userName: session.name,
    action: "DEPOSIT_VOID",
    entity: "Deposit",
    entityId: id,
    detail: { reason, totalCents: deposit.totalCents, businessDate: deposit.businessDate },
  });

  revalidatePath("/dashboard");
  revalidatePath("/owner");
  revalidatePath(`/deposit/${id}`);
  return {};
}

/**
 * Permanently remove a deposit.
 *
 * Voiding is still the normal correction: it leaves the original figure on the
 * record where anyone can see what happened. Deleting takes the row out of the
 * books entirely — the calendar, the day totals and the month totals all change
 * as though it was never filed.
 *
 * The Company Admin can delete any deposit. A store manager gets the same
 * window they already have for voiding: their own store, and only on the day
 * the slip was entered. Past that the figure belongs to the month's books and
 * the office has to make the call.
 *
 * Either way the whole deposit is copied into the audit log before it goes. The
 * row disappears; the evidence that it existed does not.
 */
export async function deleteDepositAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();

  const id = Number(formData.get("depositId"));
  const reason = String(formData.get("reason") ?? "").trim();
  const confirm = String(formData.get("confirmAmount") ?? "").trim();

  if (!Number.isInteger(id)) return { error: "Bad deposit id." };
  if (reason.length < 5) return { error: "Give a reason (at least 5 characters)." };

  const deposit = await prisma.deposit.findUnique({
    where: { id },
    include: { store: true, enteredBy: true },
  });
  if (!deposit) return { error: "Deposit not found." };

  const isOwner = session.role === "OWNER";

  if (!isOwner) {
    if (deposit.storeId !== session.storeId) {
      await audit({
        userId: session.userId,
        userName: session.name,
        action: "VIEW_DENIED",
        entity: "Deposit",
        entityId: id,
        detail: { attempted: "delete", reason: "other store" },
      });
      return { error: "Not your store." };
    }
    if (ymdInBusinessTz(deposit.createdAt) !== todayYmd()) {
      await audit({
        userId: session.userId,
        userName: session.name,
        action: "VIEW_DENIED",
        entity: "Deposit",
        entityId: id,
        detail: { attempted: "delete", reason: "past today" },
      });
      return {
        error:
          "Past today, only the Company Admin can delete a deposit. Call the office.",
      };
    }
  }

  // Re-key the amount, the same guard used when filing it. Deleting the wrong
  // row is not recoverable from the app.
  const confirmCents = parseDollarsToCents(confirm);
  if (confirmCents === null || confirmCents !== deposit.totalCents) {
    return {
      error: "Type the exact amount of this deposit to confirm the deletion.",
      fieldErrors: { confirmAmount: "Does not match this deposit" },
    };
  }

  await audit({
    userId: session.userId,
    userName: session.name,
    action: "DEPOSIT_DELETE",
    entity: "Deposit",
    entityId: deposit.id,
    detail: {
      reason,
      // A full copy, so the figure is still recoverable from the trail.
      deposit: {
        id: deposit.id,
        businessDate: deposit.businessDate,
        storeNumber: deposit.store.storeNumber,
        storeName: deposit.store.name,
        totalCents: deposit.totalCents,
        status: deposit.status,
        bagNumber: deposit.bagNumber,
        note: deposit.note,
        filedBy: deposit.enteredBy.name,
        filedAt: deposit.createdAt.toISOString(),
        voidReason: deposit.voidReason,
      },
    },
  });

  await prisma.deposit.delete({ where: { id } });

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/${deposit.businessDate}`);
  revalidatePath("/owner");
  revalidatePath(`/owner/day/${deposit.businessDate}`);

  redirect(
    isOwner
      ? `/owner/day/${deposit.businessDate}?deleted=1`
      : `/dashboard/${deposit.businessDate}?deleted=1`,
  );
}

// ------------------------------------------------------------- closures

/**
 * Set or end a store's temporary closure from the Company Admin screen — the
 * same thing `npm run store:close` does, without needing a terminal.
 *
 * Ending a closure that has already started does not wipe it: the closure is
 * cut short to yesterday, so the days the store really was shut keep reading
 * "Closed" instead of turning into a run of missed deposits.
 */
export async function setClosureAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState & { saved?: string }> {
  const session = await requireSession();
  if (session.role !== "OWNER") {
    return { error: "Only the Company Admin can change a store's closure." };
  }

  const storeId = Number(formData.get("storeId"));
  if (!Number.isInteger(storeId)) return { error: "Bad store id." };
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) return { error: "Store not found." };

  const today = todayYmd();
  const reopen = formData.get("intent") === "reopen";

  let closedFrom: string | null;
  let closedUntil: string | null;
  let saved: string;

  if (reopen) {
    const yesterday = addDays(today, -1);
    if (store.closedFrom && store.closedFrom <= yesterday) {
      closedFrom = store.closedFrom;
      closedUntil = yesterday;
    } else {
      closedFrom = null;
      closedUntil = null;
    }
    saved = "Open again. A deposit is expected from today.";
  } else {
    const from = String(formData.get("closedFrom") ?? "").trim();
    const until = String(formData.get("closedUntil") ?? "").trim();
    if (!isYmd(from)) return { error: "Pick the first day the store is closed." };
    if (!isYmd(until)) return { error: "Pick the last day the store is closed." };
    if (until < from) return { error: "The last closed day is before the first one." };
    closedFrom = from;
    closedUntil = until;
    saved = `Saved. Deposits are expected again from ${longDate(addDays(until, 1))}.`;
  }

  await prisma.store.update({
    where: { id: storeId },
    data: { closedFrom, closedUntil },
  });

  await audit({
    userId: session.userId,
    userName: session.name,
    action: reopen ? "STORE_REOPENED" : "STORE_CLOSED",
    entity: "Store",
    entityId: storeId,
    detail: {
      storeNumber: store.storeNumber,
      closedFrom,
      closedUntil,
      was: { closedFrom: store.closedFrom, closedUntil: store.closedUntil },
      via: "admin screen",
    },
  });

  revalidatePath("/dashboard");
  revalidatePath("/owner");
  revalidatePath(`/owner/store/${storeId}`);
  return { saved };
}
