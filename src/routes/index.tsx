import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";
import {
  ShoppingCart,
  Minus,
  Plus,
  Trash2,
  MapPin,
  CreditCard,
  QrCode,
  Banknote,
  ShieldCheck,
  Star,
  ChevronRight,
  Copy,
  Flame,
  ClipboardList,
  Search,
  ArrowLeft,
  Bike,
  Store,
  Clock,
  Ticket,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { brl, formatPhone, onlyDigits } from "@/lib/formatters";
import { getEffectivePrice } from "@/lib/promotions";
import hotboxLogo from "@/assets/hotbox-logo.png.asset.json";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/")({
  component: CustomerHome,
});

type Product = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  sale_price: number;
  image_url: string | null;
  kind: string;
  featured: boolean;
  active: boolean;
  promotion_active?: boolean | null;
  promotion_price?: number | null;
  promotion_type?: string | null;
  promotion_start_at?: string | null;
  promotion_end_at?: string | null;
  promotion_days_of_week?: number[] | null;
  promotion_time_start?: string | null;
  promotion_time_end?: string | null;
  promotion_label?: string | null;
};
type CartItem = { product: Product; qty: number; notes: string };
type View = "list" | "detail" | "cart" | "checkout";
type ActiveFilter = "ativos" | "inativos" | "todos";

const MY_ORDERS_KEY = "hb_my_orders";
function pushMyOrder(id: string) {
  try {
    const raw = localStorage.getItem(MY_ORDERS_KEY);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    if (!ids.includes(id)) ids.unshift(id);
    localStorage.setItem(MY_ORDERS_KEY, JSON.stringify(ids.slice(0, 30)));
  } catch {
    /* localStorage indisponível */
  }
}

function CustomerHome() {
  const nav = useNavigate();
  const [products, setProducts] = useState<Product[]>([]);
  const [storeName, setStoreName] = useState("HotBox Delivery");
  const [deliveryFee, setDeliveryFee] = useState(0);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [placing, setPlacing] = useState(false);
  const [pixKey, setPixKey] = useState("");
  const [pixCopiaCola, setPixCopiaCola] = useState("");
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [bannerTagline, setBannerTagline] = useState(
    "Batatas recheadas, hambúrgueres artesanais e porções irresistíveis. Direto do forno pra sua casa.",
  );
  const [deliveryTime, setDeliveryTime] = useState<number | null>(null);
  const [stripeEnabled, setStripeEnabled] = useState(false);
  const [cashEnabled, setCashEnabled] = useState(true);
  const [pixEnabled, setPixEnabled] = useState(true);
  const [cardEnabled, setCardEnabled] = useState(true);
  const [pixQrUrl, setPixQrUrl] = useState("");


  const [couponInput, setCouponInput] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; discount: number } | null>(null);
  const [couponError, setCouponError] = useState("");
  const [checkingCoupon, setCheckingCoupon] = useState(false);

  const [view, setView] = useState<View>("list");
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("Tudo");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("ativos");
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [detailQty, setDetailQty] = useState(1);
  const [detailNotes, setDetailNotes] = useState("");
  const [ingredientNames, setIngredientNames] = useState<string[]>([]);

  const [form, setForm] = useState({
    name: "",
    phone: "",
    deliveryMode: "delivery" as "delivery" | "pickup",
    street: "",
    number: "",
    complement: "",
    neighborhood: "",
    city: "",
    cep: "",
    payment: "pix" as "pix" | "card" | "cash",
    changeFor: "",
  });

  useEffect(() => {
    supabase
      .from("products")
      .select(
        "id,name,description,category,sale_price,image_url,kind,featured,active,promotion_active,promotion_price,promotion_type,promotion_start_at,promotion_end_at,promotion_days_of_week,promotion_time_start,promotion_time_end,promotion_label",
      )
      .order("category")
      .order("name")
      .then(({ data }) => setProducts((data as Product[]) ?? []));
    supabase
      .from("store_config_public")
      .select(
        "store_name,default_delivery_fee,pix_key,pix_copia_cola,estimated_delivery_time_minutes,banner_image_url,banner_tagline,stripe_enabled,digital_menu_cash_enabled,digital_menu_pix_enabled,digital_menu_card_enabled",
      )
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setStoreName(data.store_name ?? "HotBox Delivery");
          setDeliveryFee(Number(data.default_delivery_fee ?? 0));
          setPixKey(data.pix_key ?? "");
          setPixCopiaCola(data.pix_copia_cola ?? "");
          setDeliveryTime(data.estimated_delivery_time_minutes ?? null);
          setBannerUrl(data.banner_image_url ?? null);
          setStripeEnabled((data as any).stripe_enabled === true);
          setCashEnabled((data as any).digital_menu_cash_enabled !== false);
          setPixEnabled((data as any).digital_menu_pix_enabled !== false);
          setCardEnabled((data as any).digital_menu_card_enabled !== false);
          if (data.banner_tagline) setBannerTagline(data.banner_tagline);
        }
      });
  }, []);

  useEffect(() => {
    const available = [
      pixEnabled ? "pix" : null,
      cardEnabled && stripeEnabled ? "card" : null,
      cashEnabled ? "cash" : null,
    ].filter(Boolean) as Array<"pix" | "card" | "cash">;
    if (!available.includes(form.payment) && available[0]) {
      setForm((current) => ({ ...current, payment: available[0] }));
    }
  }, [pixEnabled, cardEnabled, stripeEnabled, cashEnabled]);

  useEffect(() => {
    const code = pixCopiaCola || pixKey;
    if (!code) { setPixQrUrl(""); return; }
    QRCode.toDataURL(code, { width: 280, margin: 1, errorCorrectionLevel: "M" })
      .then(setPixQrUrl)
      .catch(() => setPixQrUrl(""));
  }, [pixCopiaCola, pixKey]);

  async function copyPixCode() {
    const code = pixCopiaCola || pixKey;
    if (!code) return;
    await navigator.clipboard.writeText(code);
    toast.success("Código Pix copiado");
  }

  const categories = useMemo(
    () => ["Tudo", ...Array.from(new Set(products.map((p) => p.category || "Outros")))],
    [products],
  );
  const featured = useMemo(() => products.filter((p) => p.featured), [products]);
  const filtered = useMemo(() => {
    return products.filter((p) => {
      const matchesCategory = activeCategory === "Tudo" || (p.category || "Outros") === activeCategory;
      const matchesQuery = !query.trim() || p.name.toLowerCase().includes(query.toLowerCase());
      const matchesStatus =
        activeFilter === "todos" || (activeFilter === "ativos" && p.active) || (activeFilter === "inativos" && !p.active);
      return matchesCategory && matchesQuery && matchesStatus;
    });
  }, [products, activeCategory, query, activeFilter]);

  const subtotal = cart.reduce((s, i) => s + getEffectivePrice(i.product).price * i.qty, 0);
  const isDelivery = form.deliveryMode === "delivery";
  const couponDiscount = appliedCoupon?.discount ?? 0;
  const total = Math.max(0, subtotal - couponDiscount) + (cart.length && isDelivery ? deliveryFee : 0);

  const couponCartPayload = () =>
    cart.map((i) => {
      const eff = getEffectivePrice(i.product);
      return {
        product_id: i.product.id,
        product_name: i.product.name,
        qty: i.qty,
        unit_price: eff.price,
        list_price: eff.listPrice,
        is_promotion_price: eff.isPromotion,
        notes: i.notes || null,
      };
    });
  const totalQty = cart.reduce((s, i) => s + i.qty, 0);

  async function applyCoupon() {
    const code = couponInput.trim().toUpperCase();
    if (!code) return;
    setCheckingCoupon(true);
    setCouponError("");
    try {
      const { data, error } = await (supabase as any).rpc("validate_coupon_public", {
        p_code: code,
        p_subtotal: subtotal,
        p_customer_phone: onlyDigits(form.phone),
        p_cart: couponCartPayload(),
      });
      if (error) throw error;
      if (!data?.ok) {
        setAppliedCoupon(null);
        setCouponError(data?.reason || "Cupom inválido");
        return;
      }
      setAppliedCoupon({ code: data.code, discount: Number(data.discount || 0) });
      toast.success("Cupom aplicado!");
    } catch (err) {
      console.error(err);
      setAppliedCoupon(null);
      setCouponError("Não foi possível validar o cupom. Tente novamente.");
    } finally {
      setCheckingCoupon(false);
    }
  }

  function removeCoupon() {
    setAppliedCoupon(null);
    setCouponInput("");
    setCouponError("");
  }

  useEffect(() => {
    if (!appliedCoupon?.code || !cart.length) return;
    const timer = window.setTimeout(async () => {
      const { data, error } = await (supabase as any).rpc("validate_coupon_public", {
        p_code: appliedCoupon.code,
        p_subtotal: subtotal,
        p_customer_phone: onlyDigits(form.phone),
        p_cart: couponCartPayload(),
      });
      if (error || !data?.ok) {
        setAppliedCoupon(null);
        setCouponError(data?.reason || "O cupom deixou de ser válido para este carrinho.");
        return;
      }
      const nextDiscount = Number(data.discount || 0);
      setAppliedCoupon((current) => current && current.code === data.code && current.discount === nextDiscount ? current : { code: data.code, discount: nextDiscount });
      setCouponError("");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [subtotal, form.phone, cart, appliedCoupon?.code]);

  function openDetail(p: Product) {
    setSelectedProduct(p);
    setDetailQty(1);
    setDetailNotes("");
    setIngredientNames([]);
    setView("detail");
    supabase
      .from("recipe_items")
      .select("ingredients(name)")
      .eq("product_id", p.id)
      .then(({ data }) => setIngredientNames((data ?? []).map((r: any) => r.ingredients?.name).filter(Boolean)));
  }

  function addToCartFromDetail() {
    if (!selectedProduct) return;
    setCart((c) => {
      const ex = c.find((i) => i.product.id === selectedProduct.id && i.notes === detailNotes);
      if (ex) return c.map((i) => (i === ex ? { ...i, qty: i.qty + detailQty } : i));
      return [...c, { product: selectedProduct, qty: detailQty, notes: detailNotes }];
    });
    toast.success(`${selectedProduct.name} adicionado`);
    setView("list");
  }

  const changeQty = (idx: number, d: number) =>
    setCart((c) => c.map((i, ix) => (ix === idx ? { ...i, qty: Math.max(0, i.qty + d) } : i)).filter((i) => i.qty > 0));
  const updateNotes = (idx: number, notes: string) =>
    setCart((c) => c.map((i, ix) => (ix === idx ? { ...i, notes } : i)));
  const removeItem = (idx: number) => setCart((c) => c.filter((_, ix) => ix !== idx));

  async function placeOrder() {
    if (!cart.length) return toast.error("Seu carrinho está vazio");
    if (!form.name || !form.phone) return toast.error("Preencha nome e telefone");
    if (isDelivery && (!form.street || !form.number || !form.neighborhood)) return toast.error("Preencha rua, número e bairro");
    if (form.payment === "pix" && !(pixCopiaCola || pixKey)) return toast.error("Pix ainda não foi configurado pela loja");
    if (form.payment === "card" && !stripeEnabled) return toast.error("Cartão indisponível no momento");
    // A confirmação definitiva do cupom acontece no banco junto com a criação do pedido.
    // Assim limite geral, limite por cliente e primeira compra não sofrem condição de corrida.
    setPlacing(true);
    try {
      const items = couponCartPayload();
      const { data: created, error } = await (supabase as any).rpc("create_site_order_secure", {
        p_order: {
          customer_name: form.name,
          customer_phone: onlyDigits(form.phone),
          delivery_mode: form.deliveryMode,
          address_street: isDelivery ? form.street : null,
          address_number: isDelivery ? form.number : null,
          address_complement: isDelivery ? form.complement || null : null,
          address_neighborhood: isDelivery ? form.neighborhood || null : null,
          address_city: isDelivery ? form.city || null : null,
          address_cep: isDelivery ? form.cep || null : null,
          payment_method: form.payment,
          payment_timing: "now",
          change_for: null,
          pix_code: form.payment === "pix" ? pixCopiaCola || pixKey || null : null,
          delivery_fee: isDelivery ? deliveryFee : 0,
        },
        p_items: items,
        p_coupon_code: appliedCoupon?.code || null,
      });
      if (error) throw error;
      if (!created?.id) throw new Error("Pedido não retornado pelo servidor");
      const order = { id: created.id, order_number: created.order_number };


      pushMyOrder(order.id);

      if (form.payment === "card") {
        const { createStripeCheckout } = await import("@/lib/stripe.functions");
        const res = await createStripeCheckout({ data: { orderId: order.id, origin: window.location.origin } });
        if ("url" in res && res.url) {
          setCart([]);
          window.location.href = res.url;
          return;
        }
        toast.error(("error" in res && res.error) || "Falha ao iniciar pagamento");
      } else {
        toast.success(form.payment === "pix"
          ? `Pedido #${order.order_number} criado. Aguardando confirmação do Pix.`
          : `Pedido #${order.order_number} criado. Aguardando confirmação do pagamento em dinheiro.`);
      }


      setCart([]);
      removeCoupon();
      nav({ to: "/pedido/$id", params: { id: order.id } });
    } catch (err: any) {
      console.error(err);
      const message = String(err?.message || "");
      if (/cupom|primeira compra|limite|promoção|promocao/i.test(message)) {
        setAppliedCoupon(null);
        setCouponError(message.replace(/^.*?:\s*/, ""));
        toast.error(message.replace(/^.*?:\s*/, ""));
      } else {
        toast.error("Não foi possível enviar o pedido. Tente novamente.");
      }
    } finally {
      setPlacing(false);
    }
  }

  if (view === "detail" && selectedProduct) {
    const p = selectedProduct;
    return (
      <div className="min-h-screen bg-background pb-28">
        <div className="relative">
          <button
            onClick={() => setView("list")}
            className="absolute left-4 top-4 z-10 grid size-9 place-items-center rounded-full bg-black/50 text-white backdrop-blur"
          >
            <ArrowLeft className="size-5" />
          </button>
          <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-2xl bg-white/95 p-1.5 shadow-lg backdrop-blur">
            <img src={hotboxLogo.url} alt="HotBox Delivery" className="size-9 rounded-xl object-cover" />
          </div>
          {p.image_url ? (
            <img src={p.image_url} alt={p.name} className="h-64 w-full object-cover sm:h-80" />
          ) : (
            <div className="grid h-64 w-full place-items-center bg-muted text-sm text-muted-foreground sm:h-80">
              Sem foto
            </div>
          )}
        </div>

        <div className="mx-auto max-w-2xl px-5 py-5">
          <h1 className="font-display text-2xl font-black uppercase tracking-tight">{p.name}</h1>
          {(() => {
            const eff = getEffectivePrice(p);
            return eff.isPromotion ? (
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-base font-semibold text-muted-foreground line-through">
                  {brl(eff.listPrice)}
                </span>
                <span className="text-2xl font-extrabold text-fuchsia-600">{brl(eff.price)}</span>
                {p.promotion_label && (
                  <span className="flex items-center gap-1 rounded-full bg-fuchsia-100 px-2 py-0.5 text-[11px] font-bold text-fuchsia-700">
                    <Ticket className="size-3" /> {p.promotion_label}
                  </span>
                )}
              </div>
            ) : (
              <p className="mt-1 text-2xl font-extrabold text-primary">{brl(eff.price)}</p>
            );
          })()}
          {p.description && <p className="mt-3 text-sm leading-relaxed text-foreground/75">{p.description}</p>}

          {ingredientNames.length > 0 && (
            <div className="mt-5 rounded-2xl border bg-card p-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Ingredientes</h3>
              <p className="mt-1 text-sm">{ingredientNames.join(", ")}</p>
            </div>
          )}

          <div className="mt-4">
            <Label className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Observações</Label>
            <Textarea
              rows={2}
              className="mt-1"
              placeholder="Ex: sem cebola, ponto da carne, etc."
              value={detailNotes}
              onChange={(e) => setDetailNotes(e.target.value)}
            />
          </div>
        </div>

        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-5 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <div className="flex items-center gap-3 rounded-full border px-3 py-2">
              <button
                onClick={() => setDetailQty((q) => Math.max(1, q - 1))}
                className="grid size-6 place-items-center"
              >
                <Minus className="size-4" />
              </button>
              <span className="w-4 text-center font-bold">{detailQty}</span>
              <button onClick={() => setDetailQty((q) => q + 1)} className="grid size-6 place-items-center">
                <Plus className="size-4" />
              </button>
            </div>
            <Button
              onClick={addToCartFromDetail}
              className="flex-1 justify-between rounded-full bg-[#ffd400] py-6 text-base font-black text-black shadow-md hover:bg-[#f4ca00]"
            >
              <span>Adicionar</span>
              <span>{brl(getEffectivePrice(p).price * detailQty)}</span>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (view === "cart") {
    return (
      <div className="min-h-screen bg-background pb-28">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-background/95 px-4 py-4 backdrop-blur">
          <button onClick={() => setView("list")}>
            <ArrowLeft className="size-5" />
          </button>
          <img src={hotboxLogo.url} alt="HotBox" className="size-9 rounded-xl object-cover" />
          <h1 className="font-display text-lg font-black tracking-tight">Sua sacola</h1>
        </header>

        <div className="mx-auto max-w-2xl space-y-3 px-4 py-4">
          {!cart.length ? (
            <p className="py-16 text-center text-sm text-muted-foreground">Seu carrinho está vazio.</p>
          ) : (
            cart.map((i, idx) => (
              <div key={idx} className="rounded-2xl border bg-card p-3">
                <div className="flex gap-3">
                  {i.product.image_url ? (
                    <img
                      src={i.product.image_url}
                      alt={i.product.name}
                      className="size-24 shrink-0 rounded-2xl object-cover"
                    />
                  ) : (
                    <div className="grid size-16 shrink-0 place-items-center rounded-xl bg-muted text-[9px] text-muted-foreground">
                      Sem foto
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="font-bold uppercase leading-tight">{i.product.name}</h4>
                      <button
                        onClick={() => removeItem(idx)}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                    {(() => {
                      const eff = getEffectivePrice(i.product);
                      return eff.isPromotion ? (
                        <p className="mt-0.5 flex items-baseline gap-1.5">
                          <span className="text-xs text-muted-foreground line-through">{brl(eff.listPrice)}</span>
                          <span className="font-bold text-fuchsia-600">{brl(eff.price)}</span>
                        </p>
                      ) : (
                        <p className="mt-0.5 font-bold text-primary">{brl(eff.price)}</p>
                      );
                    })()}
                    <div className="mt-1.5 flex w-fit items-center gap-3 rounded-full border px-2.5 py-1">
                      <button onClick={() => changeQty(idx, -1)} className="grid size-5 place-items-center">
                        <Minus className="size-3.5" />
                      </button>
                      <span className="w-4 text-center text-sm font-bold">{i.qty}</span>
                      <button onClick={() => changeQty(idx, 1)} className="grid size-5 place-items-center">
                        <Plus className="size-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
                <Input
                  className="mt-2.5 rounded-full text-sm"
                  placeholder="Observações"
                  value={i.notes}
                  onChange={(e) => updateNotes(idx, e.target.value)}
                />
              </div>
            ))
          )}

          {cart.length > 0 && (
            <div className="rounded-2xl border bg-card p-4">
              <Label className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                Cupom de desconto
              </Label>
              {appliedCoupon ? (
                <div className="mt-1.5 flex items-center justify-between rounded-full border border-emerald-300 bg-emerald-50 px-3 py-2">
                  <span className="flex items-center gap-1.5 text-sm font-bold text-emerald-700">
                    <Ticket className="size-4" /> {appliedCoupon.code}
                  </span>
                  <button onClick={removeCoupon} className="text-emerald-700 hover:text-destructive">
                    <X className="size-4" />
                  </button>
                </div>
              ) : (
                <div className="mt-1.5 flex gap-2">
                  <Input
                    className="rounded-full uppercase"
                    placeholder="Código do cupom"
                    value={couponInput}
                    onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === "Enter" && applyCoupon()}
                  />
                  <Button variant="outline" className="rounded-full" onClick={applyCoupon} disabled={checkingCoupon}>
                    Aplicar
                  </Button>
                </div>
              )}
              {couponError && <p className="mt-1 text-xs font-semibold text-destructive">{couponError}</p>}

              <div className="mt-3 flex justify-between text-sm text-foreground/70">
                <span>Subtotal</span>
                <span>{brl(subtotal)}</span>
              </div>
              {couponDiscount > 0 && (
                <div className="flex justify-between text-sm font-semibold text-emerald-600">
                  <span>Desconto ({appliedCoupon?.code})</span>
                  <span>-{brl(couponDiscount)}</span>
                </div>
              )}
              <div className="flex justify-between text-sm text-foreground/70">
                <span>Taxa de entrega</span>
                <span>{isDelivery ? brl(deliveryFee) : "Retirada"}</span>
              </div>
              <div className="mt-2 flex justify-between border-t pt-2 text-lg font-extrabold">
                <span>Total</span>
                <span>{brl(total)}</span>
              </div>
            </div>
          )}
        </div>

        {cart.length > 0 && (
          <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 py-3 backdrop-blur">
            <div className="mx-auto max-w-2xl">
              <Button
                onClick={() => setView("checkout")}
                className="w-full justify-between rounded-full bg-[#ffd400] py-6 text-base font-black text-black shadow-md hover:bg-[#f4ca00]"
              >
                <span>Finalizar pedido</span>
                <span>{brl(total)}</span>
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (view === "checkout") {
    return (
      <div className="min-h-screen bg-background pb-32">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-background/95 px-4 py-4 backdrop-blur">
          <button onClick={() => setView("cart")}>
            <ArrowLeft className="size-5" />
          </button>
          <img src={hotboxLogo.url} alt="HotBox" className="size-9 rounded-xl object-cover" />
          <h1 className="font-display text-lg font-black tracking-tight">Finalizar compra</h1>
        </header>

        <div className="mx-auto max-w-2xl space-y-6 px-4 py-5">
          <div>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Seus dados</h3>
            <div className="space-y-3">
              <div>
                <Label>Nome</Label>
                <Input
                  className="mt-1 rounded-xl"
                  placeholder="Como podemos chamar você?"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div>
                <Label>Telefone</Label>
                <Input
                  className="mt-1 rounded-xl"
                  placeholder="(00) 00000-0000"
                  value={formatPhone(form.phone)}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </div>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Modo de entrega</h3>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setForm({ ...form, deliveryMode: "delivery" })}
                className={`flex items-center justify-center gap-2 rounded-full py-3 text-sm font-bold transition ${isDelivery ? "bg-gradient-to-r from-primary to-accent text-primary-foreground shadow-md" : "border text-foreground/70"}`}
              >
                <Bike className="size-4" /> Entrega
              </button>
              <button
                onClick={() => setForm({ ...form, deliveryMode: "pickup" })}
                className={`flex items-center justify-center gap-2 rounded-full py-3 text-sm font-bold transition ${!isDelivery ? "bg-gradient-to-r from-primary to-accent text-primary-foreground shadow-md" : "border text-foreground/70"}`}
              >
                <Store className="size-4" /> Retirada
              </button>
            </div>
          </div>

          {isDelivery && (
            <div>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Endereço</h3>
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <Label>Rua</Label>
                    <Input
                      className="mt-1 rounded-xl"
                      value={form.street}
                      onChange={(e) => setForm({ ...form, street: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Número</Label>
                    <Input
                      className="mt-1 rounded-xl"
                      value={form.number}
                      onChange={(e) => setForm({ ...form, number: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <Label>Complemento</Label>
                  <Input
                    className="mt-1 rounded-xl"
                    placeholder="Apto, bloco..."
                    value={form.complement}
                    onChange={(e) => setForm({ ...form, complement: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label>Bairro</Label>
                    <Input
                      className="mt-1 rounded-xl"
                      value={form.neighborhood}
                      onChange={(e) => setForm({ ...form, neighborhood: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Cidade</Label>
                    <Input
                      className="mt-1 rounded-xl"
                      value={form.city}
                      onChange={(e) => setForm({ ...form, city: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <Label>CEP</Label>
                  <Input
                    className="mt-1 rounded-xl"
                    placeholder="00000-000"
                    value={form.cep}
                    onChange={(e) => setForm({ ...form, cep: e.target.value })}
                  />
                </div>
              </div>
            </div>
          )}

          <div>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Forma de pagamento</h3>
            <div className="grid grid-cols-3 gap-2">
              {[
                ...(pixEnabled ? [{ v: "pix", label: "Pix", icon: QrCode }] : []),
                ...(cardEnabled && stripeEnabled ? [{ v: "card", label: "Cartão", icon: CreditCard }] : []),
                ...(cashEnabled ? [{ v: "cash", label: "Dinheiro", icon: Banknote }] : []),
              ].map((opt) => (
                <button
                  key={opt.v}
                  onClick={() => setForm({ ...form, payment: opt.v as any })}
                  className={`flex flex-col items-center gap-1 rounded-2xl border-2 py-3 text-xs font-bold transition ${form.payment === opt.v ? "border-primary bg-primary/5 text-primary" : "border-border text-foreground/60"}`}
                >
                  <opt.icon className="size-5" /> {opt.label}
                </button>
              ))}
            </div>


            {form.payment === "pix" && (
              <div className="mt-4 rounded-3xl border border-amber-200 bg-amber-50/70 p-4">
                <div className="flex items-start gap-4">
                  {pixQrUrl && <img src={pixQrUrl} alt="QR Code Pix" className="size-32 rounded-2xl border bg-white p-2" />}
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-amber-950">Pague antes do preparo</p>
                    <p className="mt-1 text-xs leading-relaxed text-amber-900/70">Escaneie o QR Code ou copie o código Pix. O pedido fica aguardando confirmação do pagamento e nunca será cobrado na entrega.</p>
                    <button type="button" onClick={copyPixCode} className="mt-3 inline-flex items-center gap-2 rounded-full bg-black px-4 py-2 text-xs font-bold text-white">
                      <Copy className="size-3.5" /> Copiar código Pix
                    </button>
                  </div>
                </div>
              </div>
            )}

            {form.payment === "cash" && (
              <div className="mt-4 rounded-3xl border border-red-200 bg-red-50 p-4 text-sm">
                <p className="font-bold text-red-950">Pagamento em dinheiro é antecipado</p>
                <p className="mt-1 text-xs leading-relaxed text-red-900/70">O pedido será criado como aguardando pagamento. A loja precisa confirmar o recebimento antes do preparo. Não existe pagamento em dinheiro na entrega.</p>
              </div>
            )}

            {form.payment === "card" && (
              <p className="mt-3 text-xs text-muted-foreground">
                Você será redirecionado para o checkout seguro do Stripe. O pedido só entra no fluxo operacional depois que o Stripe confirmar o pagamento.
              </p>
            )}
          </div>
        </div>

        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto max-w-2xl">
            <Button
              onClick={placeOrder}
              disabled={placing}
              className="w-full justify-between rounded-full bg-[#ffd400] py-6 text-base font-black text-black shadow-md hover:bg-[#f4ca00]"
            >
              <span>{placing ? "Processando..." : form.payment === "card" ? "Ir para pagamento" : "Criar pedido"}</span>
              <span>{brl(total)}</span>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f7f7f7] pb-28">
      <div className="sticky top-0 z-50 border-b border-black/5 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto max-w-2xl">
          <Link to="/" className="flex items-center gap-2.5">
            <img src={hotboxLogo.url} alt="HotBox Delivery" className="h-12 w-12 rounded-2xl object-cover shadow-sm ring-1 ring-black/10" />
            <div className="leading-tight">
              <p className="font-display text-lg font-black">
                HOT<span className="text-[#d92d20]">BOX</span>
              </p>
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#d92d20]">Delivery</p>
            </div>
            <Link to="/admin/login" className="ml-auto text-[11px] text-muted-foreground hover:text-foreground">
              Área da loja
            </Link>
          </Link>
        </div>
      </div>

      {/* ============ BANNER ============ */}
      <div
        className="relative overflow-hidden bg-gradient-to-br from-[#1c0f0b] via-[#7f1d1d] to-[#f97316] px-5 py-8 text-white"
        style={
          bannerUrl
            ? {
                backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.15), rgba(0,0,0,0.55)), url(${bannerUrl})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : undefined
        }
      >
        <div className="mx-auto max-w-2xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-black/25 px-3 py-1 text-xs font-bold uppercase tracking-wide backdrop-blur">
            <Flame className="size-3.5" /> Aberto agora
          </span>
          <h1 className="mt-3 font-display text-3xl font-black uppercase leading-[1.05] tracking-tight sm:text-4xl">
            Sua fome pediu.
            <br />
            A Hotbox caprichou.
          </h1>
          <p className="mt-3 max-w-md text-sm text-white/85">{bannerTagline}</p>
          <div className="mt-4 flex flex-wrap items-center gap-4 text-sm font-semibold">
            {deliveryTime && (
              <span className="flex items-center gap-1.5">
                <Clock className="size-4" /> {deliveryTime}-{deliveryTime + 15} min
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <MapPin className="size-4" /> Entrega {deliveryFee > 0 ? brl(deliveryFee) : "grátis"}
            </span>
          </div>
        </div>
      </div>

      <header className="sticky top-0 z-40 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto max-w-2xl">
          <div className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="rounded-full border-none bg-muted pl-11"
              placeholder="Buscar produtos..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-4 py-2 text-sm font-bold transition ${activeCategory === cat ? "bg-gradient-to-r from-primary to-accent text-primary-foreground shadow-md" : "border bg-card text-foreground/70"}`}
              >
                {cat === "Tudo" && <Flame className="size-3.5" />} {cat}
              </button>
            ))}
          </div>


        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-5">
        {!products.length ? (
          <div className="rounded-xl border border-dashed py-16 text-center">
            <p className="text-muted-foreground">Cardápio vazio. Volte em breve!</p>
          </div>
        ) : (
          <div className="space-y-8">
            {!query && activeCategory === "Tudo" && featured.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-1.5 font-display text-xl font-black uppercase tracking-tight">
                  <Flame className="size-5 text-primary" /> Ofertas e preferidos
                </h2>
                <div className="grid grid-cols-2 gap-3">
                  {featured.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => openDetail(p)}
                      className="group relative aspect-[4/5] overflow-hidden rounded-[24px] bg-white text-left shadow-sm ring-1 ring-black/5"
                    >
                      {p.image_url ? (
                        <img
                          src={p.image_url}
                          alt={p.name}
                          className="absolute inset-0 size-full object-cover transition group-hover:scale-105"
                        />
                      ) : (
                        <div className="absolute inset-0 bg-muted" />
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
                      <div className="absolute inset-x-0 bottom-0 p-3">
                        <p className="text-[13px] font-extrabold uppercase leading-tight text-white">{p.name}</p>
                        {(() => {
                          const eff = getEffectivePrice(p);
                          return eff.isPromotion ? (
                            <p className="mt-0.5 flex items-baseline gap-1.5">
                              <span className="text-[10px] text-white/60 line-through">{brl(eff.listPrice)}</span>
                              <span className="font-bold text-fuchsia-400">{brl(eff.price)}</span>
                            </p>
                          ) : (
                            <p className="mt-0.5 font-bold text-amber-400">{brl(eff.price)}</p>
                          );
                        })()}
                      </div>
                      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#ffd400] text-black shadow-sm">
                        <Plus className="size-5 stroke-[3]" />
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-3 font-display text-xl font-black uppercase tracking-tight">Cardápio</h2>
              {!filtered.length ? (
                <p className="py-10 text-center text-sm text-muted-foreground">Nenhum produto encontrado.</p>
              ) : (
                <div className="space-y-2.5">
                  {filtered.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => openDetail(p)}
                      className="flex w-full items-center gap-4 rounded-[24px] border border-black/5 bg-white p-3.5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                    >
                      {p.image_url ? (
                        <img src={p.image_url} alt={p.name} className="size-24 shrink-0 rounded-2xl object-cover" />
                      ) : (
                        <div className="grid size-16 shrink-0 place-items-center rounded-xl bg-muted text-[9px] text-muted-foreground">
                          Sem foto
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <h4 className="font-bold uppercase leading-tight">{p.name}</h4>
                        {p.description && (
                          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
                        )}
                        {(() => {
                          const eff = getEffectivePrice(p);
                          return eff.isPromotion ? (
                            <p className="mt-1 flex items-baseline gap-1.5">
                              <span className="text-xs text-muted-foreground line-through">{brl(eff.listPrice)}</span>
                              <span className="font-extrabold text-fuchsia-600">{brl(eff.price)}</span>
                              {p.promotion_label && (
                                <span className="flex items-center gap-1 rounded-full bg-fuchsia-100 px-1.5 py-0.5 text-[10px] font-bold text-fuchsia-700">
                                  <Ticket className="size-2.5" /> {p.promotion_label}
                                </span>
                              )}
                            </p>
                          ) : (
                            <p className="mt-1 font-extrabold text-primary">{brl(eff.price)}</p>
                          );
                        })()}
                      </div>
                      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#ffd400] text-black shadow-sm">
                        <Plus className="size-5 stroke-[3]" />
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      <footer className="mt-10 border-t bg-muted/40 py-6 text-center text-xs text-muted-foreground">
        <MapPin className="mx-auto mb-1 size-4" />
        {storeName} • Todos os direitos reservados
        <div className="mt-1">
          <Link to="/politica-de-privacidade" className="underline hover:text-foreground">
            Política de Privacidade
          </Link>
        </div>
      </footer>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-stretch gap-2 px-3 py-2">
          <Link
            to="/meus-pedidos"
            className="flex flex-1 items-center justify-center gap-2 rounded-full py-2.5 text-sm font-semibold text-foreground/80 transition hover:bg-muted"
          >
            <ClipboardList className="size-4" /> Meus pedidos
          </Link>
          <Button
            className="flex flex-1 items-center justify-center gap-2 rounded-full bg-[#ffd400] py-2.5 font-black text-black hover:bg-[#f4ca00]"
            onClick={() => setView("cart")}
          >
            <ShoppingCart className="size-4" />
            {totalQty > 0 ? `Sacola • ${totalQty} • ${brl(subtotal)}` : "Ver sacola"}
          </Button>
        </div>
      </nav>
    </div>
  );
}
