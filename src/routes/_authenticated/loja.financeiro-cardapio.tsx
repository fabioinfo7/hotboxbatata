import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { brasiliaDateDaysAgo, brasiliaDateISO, brasiliaMonthStart } from "@/lib/brasilia-date";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ArrowLeft,
  Banknote,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  CreditCard,
  Edit3,
  ExternalLink,
  Loader2,
  QrCode,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  WalletCards,
} from "lucide-react";
import {
  hideDigitalMenuFinanceRecordFn,
  listDigitalMenuFinanceFn,
  updateDigitalMenuFinanceMetaFn,
} from "@/lib/digital-menu-finance.functions";

export const Route = createFileRoute("/_authenticated/loja/financeiro-cardapio")({
  component: DigitalMenuFinancePage,
});

type PaymentFilter = "all" | "pix" | "card";
type Summary = {
  transactions?: number;
  sales_total?: number;
  customer_paid_total?: number;
  pix_total?: number;
  pix_count?: number;
  card_total?: number;
  card_count?: number;
};

type Tx = {
  id: string;
  status: string;
  payment_kind: string;
  customer_name: string;
  customer_phone: string;
  subtotal: number;
  delivery_fee: number;
  coupon_code: string | null;
  coupon_discount: number;
  total: number;
  order_id: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
  infinitepay_order_nsu: string | null;
  infinitepay_transaction_nsu: string | null;
  infinitepay_invoice_slug: string | null;
  infinitepay_receipt_url: string | null;
  infinitepay_amount_cents: number | null;
  infinitepay_paid_amount_cents: number | null;
  infinitepay_installments: number | null;
  infinitepay_capture_method: string | null;
  infinitepay_verified_at: string | null;
  infinitepay_webhook_payload: any;
  infinitepay_verification_payload: any;
  finance_reference: string | null;
  finance_note: string | null;
  order: any | null;
};

const PAGE_SIZE = 15;
const brl = (value: unknown) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const moneyFromCents = (value: unknown, fallback: unknown) =>
  value == null ? brl(fallback) : brl(Number(value) / 100);

const dtFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(iso?: string | null) {
  if (!iso) return "—";
  return dtFmt.format(new Date(iso));
}

function paymentLabel(tx: Tx) {
  return tx.payment_kind === "infinitepay_pix" || tx.infinitepay_capture_method === "pix" ? "Pix" : "Cartão";
}

function orderRef(tx: Tx) {
  const value = tx.order?.external_display_id || tx.order?.order_number;
  return value ? `#${String(value).replace(/^#/, "")}` : "Sem nº";
}

function SummaryCard({ icon: Icon, label, value, helper }: { icon: any; label: string; value: string; helper: string }) {
  return (
    <Card className="overflow-hidden border-0 bg-card p-5 shadow-sm ring-1 ring-black/5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-black tracking-tight sm:text-3xl">{value}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{helper}</p>
        </div>
        <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
          <Icon className="size-5" />
        </div>
      </div>
    </Card>
  );
}

function DetailItem({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-2xl border bg-muted/20 p-3">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <div className={`mt-1 break-words text-sm font-semibold ${mono ? "font-mono text-xs" : ""}`}>{value || "—"}</div>
    </div>
  );
}

function DigitalMenuFinancePage() {
  const [from, setFrom] = useState(brasiliaMonthStart());
  const [to, setTo] = useState(brasiliaDateISO());
  const [payment, setPayment] = useState<PaymentFilter>("all");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Tx[]>([]);
  const [count, setCount] = useState(0);
  const [periodSummary, setPeriodSummary] = useState<Summary>({});
  const [allTimeSummary, setAllTimeSummary] = useState<Summary>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Tx | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const rangeStart = count ? (page - 1) * PAGE_SIZE + 1 : 0;
  const rangeEnd = Math.min(page * PAGE_SIZE, count);

  async function load(nextPage = page) {
    setLoading(true);
    try {
      const res = await listDigitalMenuFinanceFn({ data: { from, to, payment, page: nextPage, pageSize: PAGE_SIZE } });
      if (!res?.ok) throw new Error(res?.error || "Não foi possível carregar o financeiro.");
      setRows((res.rows || []) as Tx[]);
      setCount(Number(res.count || 0));
      setPeriodSummary((res.periodSummary || {}) as Summary);
      setAllTimeSummary((res.allTimeSummary || {}) as Summary);
      setPage(Number(res.page || nextPage));
    } catch (err: any) {
      toast.error(String(err?.message || "Não foi possível carregar os recebimentos."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, payment]);

  useEffect(() => {
    if (page > totalPages) void load(totalPages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalPages]);

  function openTx(tx: Tx) {
    setSelected(tx);
    setEditing(false);
    setReference(tx.finance_reference || "");
    setNote(tx.finance_note || "");
  }

  async function saveMeta() {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await updateDigitalMenuFinanceMetaFn({ data: { checkoutId: selected.id, reference, note } });
      if (!res?.ok) throw new Error(res?.error || "Não foi possível salvar.");
      toast.success("Informações internas atualizadas.");
      setEditing(false);
      await load(page);
      setSelected((cur) => (cur ? { ...cur, finance_reference: reference.trim() || null, finance_note: note.trim() || null } : cur));
    } catch (err: any) {
      toast.error(String(err?.message || "Não foi possível salvar."));
    } finally {
      setSaving(false);
    }
  }

  async function hideRecord() {
    if (!selected) return;
    const yes = window.confirm(
      "Remover este registro da tela financeira?\n\nO pagamento e o pedido NÃO serão apagados. O registro apenas deixará de aparecer neste painel e nos totais desta página.",
    );
    if (!yes) return;
    setSaving(true);
    try {
      const res = await hideDigitalMenuFinanceRecordFn({ data: { checkoutId: selected.id } });
      if (!res?.ok) throw new Error(res?.error || "Não foi possível excluir o registro.");
      toast.success("Registro removido do financeiro do cardápio.");
      setSelected(null);
      await load(page);
    } catch (err: any) {
      toast.error(String(err?.message || "Não foi possível excluir."));
    } finally {
      setSaving(false);
    }
  }

  function quickRange(kind: "today" | "7" | "30" | "month") {
    if (kind === "today") {
      setFrom(brasiliaDateISO());
      setTo(brasiliaDateISO());
    } else if (kind === "7") {
      setFrom(brasiliaDateDaysAgo(6));
      setTo(brasiliaDateISO());
    } else if (kind === "30") {
      setFrom(brasiliaDateDaysAgo(29));
      setTo(brasiliaDateISO());
    } else {
      setFrom(brasiliaMonthStart());
      setTo(brasiliaDateISO());
    }
  }

  const periodCaption = useMemo(() => {
    if (from === to) return `Movimentações de ${from.split("-").reverse().join("/")}`;
    return `${from.split("-").reverse().join("/")} até ${to.split("-").reverse().join("/")}`;
  }, [from, to]);

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-6 px-4 py-5 sm:px-6 lg:px-8">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <Link to="/loja/financeiro" className="mb-3 inline-flex items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> Financeiro geral
          </Link>
          <div className="flex items-center gap-3">
            <div className="grid size-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <WalletCards className="size-6" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Financeiro do Cardápio Digital</h1>
              <p className="mt-1 text-sm text-muted-foreground">Recebimentos confirmados pela InfinitePay, conciliados com os pedidos da HotBox.</p>
            </div>
          </div>
        </div>
        <Button variant="outline" className="gap-2 rounded-xl" onClick={() => load(page)} disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Atualizar
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard icon={CircleDollarSign} label="Total confirmado" value={brl(periodSummary.sales_total)} helper={`${Number(periodSummary.transactions || 0)} transações no período`} />
        <SummaryCard icon={Banknote} label="Pago pelos clientes" value={brl(periodSummary.customer_paid_total)} helper="Valor retornado pela InfinitePay como paid_amount" />
        <SummaryCard icon={QrCode} label="Pix" value={brl(periodSummary.pix_total)} helper={`${Number(periodSummary.pix_count || 0)} pagamentos`} />
        <SummaryCard icon={CreditCard} label="Cartão" value={brl(periodSummary.card_total)} helper={`${Number(periodSummary.card_count || 0)} pagamentos`} />
        <SummaryCard icon={ShoppingBag} label="Total acumulado" value={brl(allTimeSummary.sales_total)} helper="Soma histórica das vendas confirmadas pelo cardápio digital" />
      </div>

      <Card className="border-0 p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="grid flex-1 gap-3 sm:grid-cols-3">
            <div>
              <Label className="text-xs font-bold">De</Label>
              <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="mt-1 rounded-xl" />
            </div>
            <div>
              <Label className="text-xs font-bold">Até</Label>
              <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="mt-1 rounded-xl" />
            </div>
            <div>
              <Label className="text-xs font-bold">Forma de pagamento</Label>
              <Select value={payment} onValueChange={(v) => setPayment(v as PaymentFilter)}>
                <SelectTrigger className="mt-1 rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Pix + cartão</SelectItem>
                  <SelectItem value="pix">Somente Pix</SelectItem>
                  <SelectItem value="card">Somente cartão</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => quickRange("today")}>Hoje</Button>
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => quickRange("7")}>7 dias</Button>
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => quickRange("30")}>30 dias</Button>
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => quickRange("month")}>Este mês</Button>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <CalendarDays className="size-4" /> Filtro calculado pelo horário de Brasília (America/Sao_Paulo) — {periodCaption}.
        </div>
      </Card>

      <Card className="overflow-hidden border-0 shadow-sm ring-1 ring-black/5">
        <div className="flex items-center justify-between border-b px-4 py-4 sm:px-5">
          <div>
            <h2 className="font-black">Transações</h2>
            <p className="text-xs text-muted-foreground">Clique em qualquer linha para abrir todos os detalhes.</p>
          </div>
          <div className="rounded-full bg-muted px-3 py-1 text-xs font-bold">{count} registros</div>
        </div>

        {loading ? (
          <div className="grid min-h-64 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-5 animate-spin" /> Carregando recebimentos...</div>
        ) : rows.length === 0 ? (
          <div className="grid min-h-64 place-items-center px-6 text-center">
            <div><ReceiptText className="mx-auto size-10 text-muted-foreground/50" /><p className="mt-3 font-bold">Nenhuma transação encontrada</p><p className="mt-1 text-sm text-muted-foreground">Altere o período ou a forma de pagamento.</p></div>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-[11px] font-black uppercase tracking-[0.12em] text-muted-foreground">
                  <tr>
                    <th className="px-5 py-3">Data</th>
                    <th className="px-5 py-3">Pedido / Cliente</th>
                    <th className="px-5 py-3">Pagamento</th>
                    <th className="px-5 py-3 text-right">Valor</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((tx) => (
                    <tr key={tx.id} onClick={() => openTx(tx)} className="cursor-pointer transition hover:bg-muted/35">
                      <td className="px-5 py-4"><p className="font-bold">{formatDate(tx.paid_at)}</p><p className="mt-0.5 text-[11px] text-muted-foreground">Brasília</p></td>
                      <td className="px-5 py-4"><p className="font-black">{orderRef(tx)}</p><p className="mt-0.5 max-w-[280px] truncate text-xs text-muted-foreground">{tx.customer_name || "Cliente não informado"}</p></td>
                      <td className="px-5 py-4"><span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold">{paymentLabel(tx) === "Pix" ? <QrCode className="size-3.5" /> : <CreditCard className="size-3.5" />}{paymentLabel(tx)}</span></td>
                      <td className="px-5 py-4 text-right"><p className="text-base font-black">{moneyFromCents(tx.infinitepay_amount_cents, tx.total)}</p>{tx.infinitepay_installments && tx.infinitepay_installments > 1 ? <p className="text-[11px] text-muted-foreground">{tx.infinitepay_installments}x</p> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="divide-y md:hidden">
              {rows.map((tx) => (
                <button key={tx.id} type="button" onClick={() => openTx(tx)} className="w-full p-4 text-left transition active:bg-muted/50">
                  <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold text-muted-foreground">{formatDate(tx.paid_at)}</p><p className="mt-1 font-black">{orderRef(tx)} · {tx.customer_name}</p></div><p className="text-base font-black">{moneyFromCents(tx.infinitepay_amount_cents, tx.total)}</p></div>
                  <div className="mt-3 flex items-center justify-between"><span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold">{paymentLabel(tx) === "Pix" ? <QrCode className="size-3.5" /> : <CreditCard className="size-3.5" />}{paymentLabel(tx)}</span><ChevronRight className="size-4 text-muted-foreground" /></div>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="flex flex-col gap-3 border-t px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="text-xs text-muted-foreground">Mostrando <b>{rangeStart}</b>–<b>{rangeEnd}</b> de <b>{count}</b></p>
          <div className="flex items-center justify-between gap-2 sm:justify-end">
            <Button variant="outline" size="sm" className="rounded-xl" disabled={page <= 1 || loading} onClick={() => load(page - 1)}><ChevronLeft className="mr-1 size-4" /> Anterior</Button>
            <span className="min-w-20 text-center text-xs font-black">{page} / {totalPages}</span>
            <Button variant="outline" size="sm" className="rounded-xl" disabled={page >= totalPages || loading} onClick={() => load(page + 1)}>Próxima <ChevronRight className="ml-1 size-4" /></Button>
          </div>
        </div>
      </Card>

      <div className="flex items-start gap-2 rounded-2xl border bg-muted/20 p-4 text-xs leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        <p><b>Importante:</b> “Total acumulado” é a soma das vendas confirmadas que passaram pelo cardápio digital. A API pública do Checkout Integrado não informa o saldo bancário disponível da conta InfinitePay. Valores, NSU e status confirmados pelo provedor ficam protegidos contra edição; a edição abaixo altera somente referência e observação internas.</p>
      </div>

      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-xl"><ReceiptText className="size-5" /> Transação {orderRef(selected)}</DialogTitle>
              </DialogHeader>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <DetailItem label="Status" value="Pagamento confirmado" />
                <DetailItem label="Data do pagamento" value={formatDate(selected.paid_at)} />
                <DetailItem label="Forma" value={paymentLabel(selected)} />
                <DetailItem label="Valor da venda" value={moneyFromCents(selected.infinitepay_amount_cents, selected.total)} />
                <DetailItem label="Pago pelo cliente" value={moneyFromCents(selected.infinitepay_paid_amount_cents, selected.total)} />
                <DetailItem label="Parcelas" value={selected.infinitepay_installments ? `${selected.infinitepay_installments}x` : "1x / não informado"} />
                <DetailItem label="Cliente" value={selected.customer_name} />
                <DetailItem label="Telefone" value={selected.customer_phone} />
                <DetailItem label="Pedido" value={orderRef(selected)} />
                <DetailItem label="Subtotal" value={brl(selected.subtotal)} />
                <DetailItem label="Taxa de entrega" value={brl(selected.delivery_fee)} />
                <DetailItem label="Desconto" value={brl(selected.coupon_discount)} />
                <DetailItem label="Cupom" value={selected.coupon_code || "—"} />
                <DetailItem label="Capture method" value={selected.infinitepay_capture_method || "—"} />
                <DetailItem label="Verificado em" value={formatDate(selected.infinitepay_verified_at)} />
                <DetailItem label="Transaction NSU" value={selected.infinitepay_transaction_nsu || "—"} mono />
                <DetailItem label="Order NSU" value={selected.infinitepay_order_nsu || "—"} mono />
                <DetailItem label="Invoice slug" value={selected.infinitepay_invoice_slug || "—"} mono />
                <DetailItem label="Checkout ID" value={selected.id} mono />
                <DetailItem label="Order ID" value={selected.order_id || "—"} mono />
              </div>

              {selected.infinitepay_receipt_url && (
                <a href={selected.infinitepay_receipt_url} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-2xl border bg-emerald-50 p-4 text-sm font-black text-emerald-900 hover:bg-emerald-100">
                  Abrir comprovante da InfinitePay <ExternalLink className="size-4" />
                </a>
              )}

              <div className="rounded-2xl border p-4">
                <div className="flex items-center justify-between gap-3"><div><p className="font-black">Informações internas</p><p className="text-xs text-muted-foreground">Esses campos não alteram o pagamento original.</p></div><Button variant="outline" size="sm" className="gap-2 rounded-xl" onClick={() => setEditing((v) => !v)}><Edit3 className="size-4" /> {editing ? "Cancelar" : "Editar"}</Button></div>
                {editing ? (
                  <div className="mt-4 space-y-3">
                    <div><Label>Referência interna</Label><Input className="mt-1 rounded-xl" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Ex.: conferido no fechamento" /></div>
                    <div><Label>Observação</Label><textarea className="mt-1 min-h-28 w-full rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anotação administrativa sobre esta transação" /></div>
                    <Button className="rounded-xl" onClick={saveMeta} disabled={saving}>{saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}Salvar alterações</Button>
                  </div>
                ) : (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2"><DetailItem label="Referência" value={selected.finance_reference || "—"} /><DetailItem label="Observação" value={selected.finance_note || "—"} /></div>
                )}
              </div>

              <details className="rounded-2xl border p-4">
                <summary className="cursor-pointer text-sm font-black">Dados técnicos recebidos da InfinitePay</summary>
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <pre className="max-h-60 overflow-auto rounded-xl bg-muted p-3 text-[10px] leading-relaxed">{JSON.stringify(selected.infinitepay_webhook_payload || {}, null, 2)}</pre>
                  <pre className="max-h-60 overflow-auto rounded-xl bg-muted p-3 text-[10px] leading-relaxed">{JSON.stringify(selected.infinitepay_verification_payload || {}, null, 2)}</pre>
                </div>
              </details>

              <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
                <Button variant="destructive" className="gap-2 rounded-xl" onClick={hideRecord} disabled={saving}><Trash2 className="size-4" /> Excluir da lista</Button>
                <Button variant="outline" className="rounded-xl" onClick={() => setSelected(null)}>Fechar</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
