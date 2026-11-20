import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { storeMonth } from "@/lib/queries";
import { prisma } from "@/lib/db";
import { isClosedOn, longDate, monthKey, todayYmd } from "@/lib/dates";
import { fmt } from "@/lib/money";
import { AppShell, PageHead } from "@/components/AppShell";
import { MonthNav } from "@/components/MonthNav";
import { StoreCalendar } from "@/components/StoreCalendar";
import { Legend } from "@/components/Legend";
import { Stat } from "@/components/Stat";
import { DepositCard } from "@/components/DepositCard";
import { ClosureForm } from "@/components/ClosureForm";

export default async function OwnerStorePage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const session = await requireOwner();
  const { storeId: raw } = await params;
  const storeId = Number(raw);
  if (!Number.isInteger(storeId)) notFound();

  const exists = await prisma.store.findUnique({ where: { id: storeId } });
  if (!exists) notFound();

  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "")
    ? sp.month!
    : monthKey(todayYmd());

  const { store, days, summary } = await storeMonth(storeId, month);

  const deposits = await prisma.deposit.findMany({
    where: {
      storeId,
      businessDate: { gte: `${month}-01`, lte: `${month}-31` },
    },
    include: { enteredBy: true },
    orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }],
  });

  return (
    <AppShell session={session}>
      <Link href={`/owner?month=${month}`} className="backlink">
        <span aria-hidden>‹</span> All stores
      </Link>

      <PageHead
        eyebrow={`Store ${store.storeNumber} · ${store.city}`}
        title={store.name}
      />

      {isClosedOn(store, todayYmd()) && (
        <p className="notice notice-quiet">
          Closed. No deposit is required
          {store.closedUntil ? ` through ${longDate(store.closedUntil)}` : ""}
          {store.closedFrom ? `, from ${longDate(store.closedFrom)}` : ""}.
        </p>
      )}

      <div className="grid grid-cols-3 gap-2">
        <Stat label="Month total" value={fmt(summary.totalCents)} tone="accent" />
        <Stat label="Filed" value={String(summary.filed)} tone="ok" />
        <Stat label="Not filed" value={String(summary.missed)} tone="miss" />
      </div>

      <section className="card">
        <MonthNav month={month} basePath={`/owner/store/${storeId}`} />
        <div className="space-y-4 p-3.5">
          <StoreCalendar days={days} hrefFor={(ymd) => `/owner/day/${ymd}`} />
          <div className="border-t border-line pt-3">
            <Legend />
          </div>
        </div>
      </section>

      <ClosureForm
        storeId={storeId}
        closedFrom={store.closedFrom}
        closedUntil={store.closedUntil}
        today={todayYmd()}
      />

      <section className="space-y-2 pt-1">
        <h2 className="text-base font-extrabold tracking-[-0.01em]">
          Every deposit this month
        </h2>
        {deposits.length === 0 ? (
          <p className="notice notice-quiet">No deposits this month.</p>
        ) : (
          deposits.map((d) => (
            <div key={d.id} className="space-y-1">
              <div className="eyebrow px-0.5">{d.businessDate}</div>
              <DepositCard deposit={d} />
            </div>
          ))
        )}
      </section>
    </AppShell>
  );
}
