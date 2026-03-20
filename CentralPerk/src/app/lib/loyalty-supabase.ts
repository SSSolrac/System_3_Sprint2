import { supabase } from "../../utils/supabase/client";
import type { EarnOpportunity, MemberData, Reward, Transaction } from "../types/loyalty";
import {
  DEFAULT_TIER_RULES,
  monthKey,
  normalizeTierLabel,
  normalizeTierRules,
  resolveTier,
  type SupportedTier,
  type TierRule,
} from "./loyalty-engine";

type AnyRecord = Record<string, any>;
// Demo toggle for profile email edits:
// Change this to `true` only if you want demo-only profile email edits that do not
// update the real Supabase Auth login email.
// Keep this `false` for real email changes so users can log in with the new email.
const DEMO_SKIP_AUTH_EMAIL_UPDATE = false;

function getMemberPk(member: AnyRecord): { key: string; value: any } | null {
  if (member?.id !== undefined) return { key: "id", value: member.id };
  if (member?.member_id !== undefined) return { key: "member_id", value: member.member_id };
  return null;
}

function toTitleCase(value: string): string {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function mapTxType(rawType: string): Transaction["type"] {
  const value = (rawType || "").toUpperCase();
  if (value === "PURCHASE" || value === "MANUAL_AWARD" || value === "EARN") return "earned";
  if (value === "REDEEM" || value === "REDEEMED" || value === "REWARD_REDEEMED") return "redeemed";
  if (value === "GIFT" || value === "TRANSFER") return "gifted";
  if (value === "EXPIRY_DEDUCTION" || value === "EXPIRED") return "expired";
  if (value === "PENDING") return "pending";
  return "earned";
}

function getTxDateValue(tx: AnyRecord): string {
  return String(tx.transaction_date ?? tx.created_at ?? new Date().toISOString());
}

function sanitizePointsBalance(value: unknown): number {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function getTransactionNote(row: AnyRecord): string {
  return String(row.reason ?? row.description ?? "");
}

function isMissingColumnError(error: unknown, table: string, column: string): boolean {
  const message = String(
    (error as { message?: unknown; details?: unknown; hint?: unknown })?.message ??
      (error as { details?: unknown })?.details ??
      (error as { hint?: unknown })?.hint ??
      ""
  ).toLowerCase();

  return (
    message.includes(`column ${table}.${column} does not exist`) ||
    message.includes(`could not find the '${column}' column`) ||
    (message.includes(column.toLowerCase()) && message.includes("does not exist"))
  );
}

function isMissingRelationError(error: unknown, table: string): boolean {
  const message = String(
    (error as { message?: unknown; details?: unknown; hint?: unknown })?.message ??
      (error as { details?: unknown })?.details ??
      (error as { hint?: unknown })?.hint ??
      ""
  ).toLowerCase();

  return (
    message.includes(`relation "${table.toLowerCase()}" does not exist`) ||
    message.includes(`relation "public.${table.toLowerCase()}" does not exist`) ||
    message.includes(`could not find the table 'public.${table.toLowerCase()}' in the schema cache`) ||
    message.includes(`could not find the table "${table.toLowerCase()}" in the schema cache`) ||
    message.includes(`could not find the table '${table.toLowerCase()}' in the schema cache`) ||
    (message.includes(table.toLowerCase()) && message.includes("schema cache")) ||
    (message.includes(table.toLowerCase()) && message.includes("does not exist"))
  );
}

async function insertLoyaltyTransaction(payload: AnyRecord): Promise<void> {
  const attempts: AnyRecord[] = [];
  const seen = new Set<string>();

  const queueAttempt = (value: AnyRecord) => {
    const key = JSON.stringify(Object.keys(value).sort().map((item) => [item, value[item]]));
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(value);
  };

  queueAttempt({ ...payload });

  if ("reason" in payload) {
    const { reason, ...rest } = payload;
    queueAttempt({ ...rest, description: reason });
    queueAttempt(rest);
  } else if ("description" in payload) {
    const { description, ...rest } = payload;
    queueAttempt({ ...rest, reason: description });
    queueAttempt(rest);
  }

  let lastError: unknown = null;

  for (const attempt of attempts) {
    const result = await supabase.from("loyalty_transactions").insert(attempt);
    if (!result.error) return;

    const reasonMissing = isMissingColumnError(result.error, "loyalty_transactions", "reason");
    const descriptionMissing = isMissingColumnError(result.error, "loyalty_transactions", "description");
    if (!reasonMissing && !descriptionMissing) {
      throw result.error;
    }

    lastError = result.error;
  }

  if (lastError) throw lastError;
  throw new Error("Unable to insert loyalty transaction.");
}

const WELCOME_PACKAGE_REASON = "Welcome Package Bonus";
const WELCOME_PACKAGE_POINTS = 100;

export type EarningRule = {
  tier_label: SupportedTier;
  peso_per_point: number;
  multiplier: number;
  is_active: boolean;
};

async function grantWelcomePackageForMember(member: AnyRecord, memberPk: { key: string; value: any }) {
  const existingWelcomeRes = await supabase
    .from("loyalty_transactions")
    .select("*")
    .eq("member_id", memberPk.value)
    .limit(200);
  if (existingWelcomeRes.error) throw existingWelcomeRes.error;
  const existingWelcome = ((existingWelcomeRes.data || []) as AnyRecord[]).find(
    (row) => getTransactionNote(row) === WELCOME_PACKAGE_REASON
  );
  if (existingWelcome) return { granted: false, pointsAdded: 0 };

  const rules = await fetchTierRules();

  await insertLoyaltyTransaction({
    member_id: memberPk.value,
    transaction_type: "EARN",
    points: WELCOME_PACKAGE_POINTS,
    reason: WELCOME_PACKAGE_REASON,
  });

  const refreshedMemberRes = await supabase
    .from("loyalty_members")
    .select("points_balance,tier")
    .eq(memberPk.key, memberPk.value)
    .limit(1)
    .maybeSingle();
  if (refreshedMemberRes.error) throw refreshedMemberRes.error;
  const newBalance = sanitizePointsBalance(refreshedMemberRes.data?.points_balance ?? member.points_balance ?? 0);
  const newTier = normalizeTierLabel(
    String(refreshedMemberRes.data?.tier ?? resolveTier(newBalance, rules))
  ) as SupportedTier;

  return { granted: true, pointsAdded: WELCOME_PACKAGE_POINTS, newBalance, newTier };
}

async function processMemberExpiredPoints(memberPk: { key: string; value: any }) {
  const txQuery = await supabase
    .from("loyalty_transactions")
    .select("points,transaction_type,expiry_date")
    .eq("member_id", memberPk.value)
    .limit(500);

  if (txQuery.error) throw txQuery.error;
  const rows = (txQuery.data || []) as AnyRecord[];
  if (rows.length === 0) return;

  const now = Date.now();
  const expiredEarned = rows
    .filter((row) => Number(row.points || 0) > 0 && row.expiry_date && new Date(row.expiry_date).getTime() < now)
    .reduce((sum, row) => sum + Math.abs(Number(row.points || 0)), 0);
  const alreadyDeducted = rows
    .filter((row) => String(row.transaction_type || "").toUpperCase() === "EXPIRY_DEDUCTION")
    .reduce((sum, row) => sum + Math.abs(Number(row.points || 0)), 0);
  const totalExpired = Math.max(0, expiredEarned - alreadyDeducted);
  if (totalExpired === 0) return;

  const { data: memberNow, error: memberErr } = await supabase
    .from("loyalty_members")
    .select("points_balance")
    .eq(memberPk.key, memberPk.value)
    .limit(1)
    .maybeSingle();
  if (memberErr) throw memberErr;

  const rules = await fetchTierRules();
  const currentBalance = sanitizePointsBalance(memberNow?.points_balance ?? 0);
  const newBalance = Math.max(0, currentBalance - totalExpired);
  const newTier = resolveTier(newBalance, rules);

  await insertLoyaltyTransaction({
    member_id: memberPk.value,
    transaction_type: "EXPIRY_DEDUCTION",
    points: -Math.abs(totalExpired),
    reason: "Points Expired",
  });

  const updateRes = await supabase
    .from("loyalty_members")
    .update({ points_balance: newBalance, tier: newTier })
    .eq(memberPk.key, memberPk.value);
  if (updateRes.error) throw updateRes.error;
}

export async function processAllMemberExpiredPoints() {
  const { data, error } = await supabase.from("loyalty_members").select("id,member_id");
  if (error) throw error;
  const members = (data || []) as AnyRecord[];

  for (const member of members) {
    const pk = getMemberPk(member);
    if (!pk) continue;
    await processMemberExpiredPoints(pk);
  }
}

export async function fetchTierRules(): Promise<TierRule[]> {
  const { data, error } = await supabase
    .from("points_rules")
    .select("tier_label,min_points,is_active")
    .eq("is_active", true)
    .order("min_points", { ascending: false });

  if (error || !data || data.length === 0) return DEFAULT_TIER_RULES;
  return normalizeTierRules(data as TierRule[]);
}

export async function saveTierRules(rules: TierRule[]): Promise<void> {
  const normalized = normalizeTierRules(rules);
  const updates = normalized.map((rule) => ({
    tier_label: normalizeTierLabel(rule.tier_label),
    min_points: Math.max(0, Math.floor(Number(rule.min_points) || 0)),
    is_active: true,
  }));

  const { error } = await supabase.from("points_rules").upsert(updates, { onConflict: "tier_label" });
  if (error) throw error;
}


export async function fetchActiveEarningRules(): Promise<EarningRule[]> {
  const { data, error } = await supabase
    .from("earning_rules")
    .select("tier_label,peso_per_point,multiplier,is_active,effective_at")
    .eq("is_active", true)
    .order("effective_at", { ascending: false });

  if (error || !data || data.length === 0) {
    return [
      { tier_label: "Bronze", peso_per_point: 10, multiplier: 1, is_active: true },
      { tier_label: "Silver", peso_per_point: 10, multiplier: 1.25, is_active: true },
      { tier_label: "Gold", peso_per_point: 10, multiplier: 1.5, is_active: true },
    ];
  }

  const latestByTier = new Map<SupportedTier, EarningRule>();
  for (const row of data as AnyRecord[]) {
    const tier = normalizeTierLabel(String(row.tier_label)) as SupportedTier;
    if (latestByTier.has(tier)) continue;
    latestByTier.set(tier, {
      tier_label: tier,
      peso_per_point: Number(row.peso_per_point || 10),
      multiplier: Number(row.multiplier || 1),
      is_active: Boolean(row.is_active ?? true),
    });
  }

  return (["Bronze", "Silver", "Gold"] as SupportedTier[]).map((tier) =>
    latestByTier.get(tier) || { tier_label: tier, peso_per_point: 10, multiplier: 1, is_active: true }
  );
}

export async function saveEarningRules(rules: EarningRule[]): Promise<void> {
  for (const rawRule of rules) {
    const tier = normalizeTierLabel(rawRule.tier_label) as SupportedTier;
    const pesoPerPoint = Math.max(0.01, Number(rawRule.peso_per_point) || 10);
    const multiplier = Math.max(0.01, Number(rawRule.multiplier) || 1);

    const { error: deactivateError } = await supabase
      .from("earning_rules")
      .update({ is_active: false })
      .eq("tier_label", tier)
      .eq("is_active", true);
    if (deactivateError) throw deactivateError;

    const { error: insertError } = await supabase.from("earning_rules").insert({
      tier_label: tier,
      peso_per_point: pesoPerPoint,
      multiplier,
      is_active: true,
      effective_at: new Date().toISOString(),
    });
    if (insertError) throw insertError;
  }
}

async function fetchEarningRuleForTier(tier: SupportedTier): Promise<EarningRule> {
  const { data, error } = await supabase
    .from("earning_rules")
    .select("tier_label,peso_per_point,multiplier,is_active")
    .eq("tier_label", tier)
    .eq("is_active", true)
    .order("effective_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    return { tier_label: tier, peso_per_point: 10, multiplier: 1, is_active: true };
  }

  return {
    tier_label: normalizeTierLabel(String(data.tier_label)) as SupportedTier,
    peso_per_point: Number(data.peso_per_point || 10),
    multiplier: Number(data.multiplier || 1),
    is_active: Boolean(data.is_active ?? true),
  };
}

export async function calculateDynamicPurchasePoints(input: {
  amountSpent: number;
  tier: SupportedTier;
}): Promise<number> {
  const amount = Math.max(0, Number(input.amountSpent) || 0);
  const rule = await fetchEarningRuleForTier(input.tier);
  const basePoints = Math.floor(amount / Math.max(rule.peso_per_point, 0.01));
  return Math.max(0, Math.floor(basePoints * Math.max(rule.multiplier, 0.01)));
}

export async function loadRewardsCatalog(): Promise<Reward[]> {
  const { data, error } = await supabase
    .from("rewards_catalog")
    .select("*")
    .eq("is_active", true)
    .order("points_cost", { ascending: true });

  if (error || !data) return [];

  return (data as AnyRecord[]).map((row) => ({
    id: String(row.reward_id ?? row.id ?? ""),
    name: String(row.name ?? "Reward"),
    description: String(row.description ?? ""),
    pointsCost: Number(row.points_cost ?? 0),
    category: String(row.category ?? "voucher") as Reward["category"],
    imageUrl: row.image_url ? String(row.image_url) : undefined,
    available: Boolean(row.is_active ?? true),
    expiryDate: row.expiry_date ? String(row.expiry_date) : undefined,
  }));
}

export async function loadEarnTasks(): Promise<EarnOpportunity[]> {
  const { data, error } = await supabase
    .from("earn_tasks")
    .select("*")
    .eq("is_active", true)
    .order("points", { ascending: false });

  if (error || !data) return [];

  return (data as AnyRecord[]).map((row) => ({
    id: String(row.task_code ?? row.id ?? ""),
    title: String(row.title ?? "Task"),
    description: String(row.description ?? ""),
    points: Number(row.points ?? 0),
    icon: String(row.icon_key ?? "user"),
    completed: Boolean(row.default_completed ?? false),
    active: Boolean(row.is_active ?? true),
  }));
}

export async function ensureWelcomePackage(memberIdentifier: string, fallbackEmail?: string) {
  const member = await findMember(memberIdentifier, fallbackEmail);
  if (!member) throw new Error("Member not found in loyalty_members.");
  const memberPk = getMemberPk(member);
  if (!memberPk) throw new Error("Member primary key is missing.");
  return grantWelcomePackageForMember(member, memberPk);
}

export async function findMember(memberIdentifier?: string, fallbackEmail?: string) {
  let lookup: { data: AnyRecord | null; error: any } = { data: null, error: null };
  const normalizedFallbackEmail = fallbackEmail?.trim();

  if (memberIdentifier) {
    lookup = await supabase
      .from("loyalty_members")
      .select("*")
      .eq("member_number", memberIdentifier)
      .limit(1)
      .maybeSingle();
  }

  if (!lookup.data && normalizedFallbackEmail) {
    lookup = await supabase
      .from("loyalty_members")
      .select("*")
      .ilike("email", normalizedFallbackEmail)
      .limit(1)
      .maybeSingle();
  }

  if (!lookup.data) {
    const authRes = await supabase.auth.getUser();
    const authEmail = authRes.data.user?.email?.trim();
    if (authEmail && authEmail.toLowerCase() !== normalizedFallbackEmail?.toLowerCase()) {
      lookup = await supabase
        .from("loyalty_members")
        .select("*")
        .ilike("email", authEmail)
        .limit(1)
        .maybeSingle();
    }
  }

  if (lookup.error) throw lookup.error;
  return lookup.data as AnyRecord | null;
}

export async function loadMemberSnapshot(currentUser: MemberData): Promise<Partial<MemberData> | null> {
  const authRes = await supabase.auth.getUser();
  const authEmail = String(authRes.data.user?.email || "").trim().toLowerCase();
  const authUser = authRes.data.user;
  const member = authEmail
    ? await findMember(undefined, authEmail)
    : await findMember(currentUser.memberId, currentUser.email);
  if (!member) {
    const authFullName =
      String(authUser?.user_metadata?.full_name || authUser?.user_metadata?.name || "").trim() || currentUser.fullName;

    return {
      fullName: authFullName || "Member",
      email: String(authUser?.email || currentUser.email || ""),
    };
  }

  const rules = await fetchTierRules();
  const pk = getMemberPk(member);
  if (!pk) return null;

  await grantWelcomePackageForMember(member, pk);
  await processMemberExpiredPoints(pk);

  const refreshedMemberRes = await supabase
    .from("loyalty_members")
    .select("*")
    .eq(pk.key, pk.value)
    .limit(1)
    .maybeSingle();
  const refreshedMember = (refreshedMemberRes.data as AnyRecord | null) ?? member;
  const currentBalance = sanitizePointsBalance(refreshedMember.points_balance ?? currentUser.points ?? 0);

  const txRes = await supabase
    .from("loyalty_transactions")
    .select("*")
    .eq("member_id", pk.value)
    .order("transaction_date", { ascending: false })
    .limit(200);

  const rawTx = (txRes.data || []) as AnyRecord[];

  let runningBalance = currentBalance;
  const transactions: Transaction[] = rawTx.map((tx, index) => {
    const signedPoints = Number(tx.points ?? 0);
    const mappedType = mapTxType(String(tx.transaction_type ?? ""));
    const mapped: Transaction = {
      id: String(tx.transaction_id ?? tx.id ?? `${index}`),
      date: getTxDateValue(tx),
      description: String(getTransactionNote(tx) || tx.transaction_type || "Transaction"),
      type: mappedType,
      points: Math.abs(signedPoints),
      balance: runningBalance,
      category: getTransactionNote(tx) ? "System" : "Purchase",
      receiptId: tx.receipt_id ? String(tx.receipt_id) : undefined,
    };
    if (mappedType !== "pending") {
      runningBalance -= signedPoints;
    }
    return mapped;
  });

  const nowMonth = monthKey(new Date());
  const isCurrentMonthTx = (tx: AnyRecord) => monthKey(getTxDateValue(tx)) === nowMonth;
  const pendingPoints = rawTx
    .filter((tx) => mapTxType(String(tx.transaction_type ?? "")) === "pending" && Number(tx.points || 0) > 0)
    .reduce((sum, tx) => sum + Number(tx.points || 0), 0);

  const earnedThisMonth = rawTx
    .filter(
      (tx) =>
        mapTxType(String(tx.transaction_type ?? "")) === "earned" &&
        Number(tx.points || 0) > 0 &&
        isCurrentMonthTx(tx)
    )
    .reduce((sum, tx) => sum + Number(tx.points || 0), 0);

  const redeemedThisMonth = rawTx
    .filter(
      (tx) =>
        mapTxType(String(tx.transaction_type ?? "")) === "redeemed" &&
        Number(tx.points || 0) !== 0 &&
        isCurrentMonthTx(tx)
    )
    .reduce((sum, tx) => sum + Math.abs(Number(tx.points || 0)), 0);

  const rawLifetimePoints = rawTx
    .filter(
      (tx) => mapTxType(String(tx.transaction_type ?? "")) === "earned" && Number(tx.points || 0) > 0
    )
    .reduce((sum, tx) => sum + Number(tx.points || 0), 0);
  const lifetimePoints = rawLifetimePoints;

  const upcomingExpiring = rawTx.filter((tx) => {
    if (!tx.expiry_date) return false;
    const expiryDate = new Date(tx.expiry_date);
    const ms = expiryDate.getTime() - Date.now();
    const days = ms / (1000 * 60 * 60 * 24);
    return Number(tx.points || 0) > 0 && days >= 0 && days <= 30;
  });

  const expiringPoints = upcomingExpiring.reduce((sum, tx) => sum + Number(tx.points || 0), 0);
  const nearestDays = upcomingExpiring.length
    ? Math.max(
        0,
        Math.min(
          ...upcomingExpiring.map((tx) =>
            Math.ceil((new Date(tx.expiry_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
          )
        )
      )
    : 0;

  const tier = normalizeTierLabel(resolveTier(currentBalance, rules)) as MemberData["tier"];

  return {
    memberId: String(refreshedMember.member_number || currentUser.memberId),
    fullName: `${refreshedMember.first_name || ""} ${refreshedMember.last_name || ""}`.trim() || currentUser.fullName,
    email: String(refreshedMember.email || currentUser.email),
    phone: String(refreshedMember.phone || currentUser.phone),
    birthdate: refreshedMember.birthdate ? String(refreshedMember.birthdate) : String(currentUser.birthdate || ""),
    address: String(refreshedMember.address || currentUser.address || ""),
    profileImage: String(refreshedMember.profile_photo_url || currentUser.profileImage || ""),
    memberSince: refreshedMember.enrollment_date
      ? new Date(refreshedMember.enrollment_date).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : currentUser.memberSince,
    points: currentBalance,
    pendingPoints,
    lifetimePoints,
    earnedThisMonth,
    redeemedThisMonth,
    expiringPoints,
    daysUntilExpiry: nearestDays,
    tier,
    transactions,
  };
}

export async function loadMemberActivity(memberIdentifier: string, fallbackEmail?: string) {
  const member = await findMember(memberIdentifier, fallbackEmail);
  if (!member) throw new Error("Member not found in loyalty_members.");
  const pk = getMemberPk(member);
  if (!pk) throw new Error("Member primary key is missing.");

  const rules = await fetchTierRules();
  await processMemberExpiredPoints(pk);

  const memberRes = await supabase
    .from("loyalty_members")
    .select("*")
    .eq(pk.key, pk.value)
    .limit(1)
    .maybeSingle();
  if (memberRes.error) throw memberRes.error;
  const refreshed = (memberRes.data || member) as AnyRecord;

  const txRes = await supabase
    .from("loyalty_transactions")
    .select("*")
    .eq("member_id", pk.value)
    .order("transaction_date", { ascending: false })
    .limit(500);
  if (txRes.error) throw txRes.error;
  const rawTx = (txRes.data || []) as AnyRecord[];

  return {
    balance: {
      member_id: String(refreshed.member_number || memberIdentifier),
      points_balance: Number(refreshed.points_balance || 0),
      tier: resolveTier(Number(refreshed.points_balance || 0), rules),
    },
    history: rawTx.map((tx) => ({
      type: String(tx.transaction_type || ""),
      points: Number(tx.points || 0),
      date: getTxDateValue(tx),
      expiry_date: tx.expiry_date ? String(tx.expiry_date) : null,
      reason: getTransactionNote(tx),
    })),
  };
}

export async function awardMemberPoints(input: {
  memberIdentifier: string;
  fallbackEmail?: string;
  points: number;
  transactionType: "PURCHASE" | "MANUAL_AWARD" | "EARN";
  reason: string;
  amountSpent?: number;
}) {
  const member = await findMember(input.memberIdentifier, input.fallbackEmail);
  if (!member) throw new Error("Member not found in loyalty_members.");
  const pk = getMemberPk(member);
  if (!pk) throw new Error("Member primary key is missing.");

  const rules = await fetchTierRules();
  const currentBalance = sanitizePointsBalance(member.points_balance ?? 0);
  let pointsToAdd = Math.max(0, Math.floor(input.points));
  const memberTier = normalizeTierLabel(String(member.tier || "Bronze")) as SupportedTier;
  if (input.transactionType === "PURCHASE") {
    const purchaseAmount = Number(input.amountSpent || 0);
    pointsToAdd = await calculateDynamicPurchasePoints({ amountSpent: purchaseAmount, tier: memberTier });
  }
  const newBalance = currentBalance + pointsToAdd;
  const newTier = resolveTier(newBalance, rules);

  const txPayload: AnyRecord = {
    member_id: pk.value,
    transaction_type: input.transactionType,
    points: pointsToAdd,
    reason: input.reason,
  };
  if (input.amountSpent !== undefined) txPayload.amount_spent = input.amountSpent;
  if (input.transactionType === "PURCHASE") {
    txPayload.expiry_date = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  }

  await insertLoyaltyTransaction(txPayload);

  const updateRes = await supabase
    .from("loyalty_members")
    .update({ points_balance: newBalance, tier: newTier })
    .eq(pk.key, pk.value);
  if (updateRes.error) throw updateRes.error;

  return { newBalance, newTier, pointsAdded: pointsToAdd };
}

export async function redeemMemberPoints(input: {
  memberIdentifier: string;
  fallbackEmail?: string;
  points: number;
  reason: string;
  transactionType?: "REDEEM" | "GIFT";
}) {
  const member = await findMember(input.memberIdentifier, input.fallbackEmail);
  if (!member) throw new Error("Member not found in loyalty_members.");
  const pk = getMemberPk(member);
  if (!pk) throw new Error("Member primary key is missing.");

  const rules = await fetchTierRules();
  const currentBalance = sanitizePointsBalance(member.points_balance ?? 0);
  const pointsToDeduct = Math.max(0, Math.floor(input.points));
  if (pointsToDeduct > currentBalance) throw new Error("Not enough points.");

  const newBalance = Math.max(0, currentBalance - pointsToDeduct);
  const newTier = resolveTier(newBalance, rules);

  await insertLoyaltyTransaction({
    member_id: pk.value,
    transaction_type: input.transactionType ?? "REDEEM",
    points: -Math.abs(pointsToDeduct),
    reason: input.reason,
  });

  const fifoConsume = await supabase.rpc("loyalty_consume_points_fifo", {
    p_member_id: pk.value,
    p_points_to_consume: pointsToDeduct,
  });
  if (fifoConsume.error) throw fifoConsume.error;

  const updateRes = await supabase
    .from("loyalty_members")
    .update({ points_balance: newBalance, tier: newTier })
    .eq(pk.key, pk.value);
  if (updateRes.error) throw updateRes.error;

  return { newBalance, newTier, pointsDeducted: pointsToDeduct };
}

export async function updateMemberProfile(input: {
  memberIdentifier: string;
  fallbackEmail?: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  birthdate?: string;
  address?: string;
  profilePhotoUrl?: string;
}) {
  const member = await findMember(input.memberIdentifier, input.fallbackEmail);
  if (!member) {
    throw new Error("Member not found in loyalty_members.");
  }

  const authRes = await supabase.auth.getUser();
  if (authRes.error) throw authRes.error;

  const authEmail = authRes.data.user?.email;
  if (!authEmail) {
    throw new Error("Unable to update profile: no authenticated user email found.");
  }

  const normalizedAuthEmail = authEmail.trim().toLowerCase();
  const normalizedNewEmail = input.email.trim().toLowerCase();
  const emailChanged = normalizedNewEmail !== normalizedAuthEmail;

  let persistedAuthEmail = normalizedAuthEmail;
  let pendingEmailVerification = false;

  if (emailChanged) {
    if (DEMO_SKIP_AUTH_EMAIL_UPDATE) {
      // Demo mode:
      // update the profile table email only, and keep Supabase Auth email unchanged.
      // To restore real auth email updates, set DEMO_SKIP_AUTH_EMAIL_UPDATE to false.
      persistedAuthEmail = normalizedNewEmail;
    } else {
      const authUpdate = await supabase.auth.updateUser({ email: normalizedNewEmail });
      if (authUpdate.error) {
        throw new Error(`Unable to update auth email: ${authUpdate.error.message}`);
      }

      const authUserEmail = String(authUpdate.data.user?.email || normalizedAuthEmail).trim().toLowerCase();
      persistedAuthEmail = authUserEmail;
      pendingEmailVerification = authUserEmail !== normalizedNewEmail;
    }
  }

  const updateRes = await supabase
    .from("loyalty_members")
    .update({
      first_name: input.firstName,
      last_name: input.lastName,
      email: persistedAuthEmail,
      phone: input.phone,
      birthdate: input.birthdate || null,
      address: input.address ?? null,
      profile_photo_url: input.profilePhotoUrl ?? null,
    })
    .eq("id", Number(member.id))
    .select("id,email");
  if (updateRes.error) throw updateRes.error;
  if (!updateRes.data?.length) throw new Error("Member not found in loyalty_members.");

  return {
    success: true,
    emailChanged,
    pendingEmailVerification,
    effectiveEmail: String(updateRes.data[0].email || persistedAuthEmail),
  };
}

export async function uploadMemberProfilePhoto(memberIdentifier: string, file: File): Promise<string> {
  const member = await findMember(memberIdentifier);
  if (!member) throw new Error("Member not found in loyalty_members.");

  const extension = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${member.member_number || memberIdentifier}/${Date.now()}.${extension}`;
  const { error: uploadError } = await supabase.storage.from("profile-photos").upload(path, file, {
    cacheControl: "3600",
    upsert: true,
    contentType: file.type,
  });
  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from("profile-photos").getPublicUrl(path);
  if (!data?.publicUrl) throw new Error("Unable to resolve profile photo URL.");
  return data.publicUrl;
}

export async function loadTierHistory(memberIdentifier: string, fallbackEmail?: string) {
  const member = await findMember(memberIdentifier, fallbackEmail);
  if (!member) throw new Error("Member not found in loyalty_members.");
  const memberId = Number(member.id ?? member.member_id);

  const { data, error } = await supabase
    .from("tier_history")
    .select("id,old_tier,new_tier,changed_at,reason")
    .eq("member_id", memberId)
    .order("changed_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data || []) as AnyRecord[];
}

export async function queueExpiryReminderNotifications() {
  const { data, error } = await supabase.rpc("loyalty_queue_expiry_warning_notifications");
  if (error) throw error;
  return Number(data || 0);
}

export async function trackMemberLoginActivity(input?: {
  memberIdentifier?: string;
  fallbackEmail?: string;
  channel?: "web" | "mobile" | "kiosk" | "system";
  source?: string;
}) {
  const member = await findMember(input?.memberIdentifier, input?.fallbackEmail);
  if (!member) return false;

  const pk = getMemberPk(member);
  if (!pk) return false;

  const result = await supabase.from("member_login_activity").insert({
    member_id: pk.value,
    login_at: new Date().toISOString(),
    channel: input?.channel ?? "web",
    source: input?.source ?? "customer_portal",
  });

  if (result.error) {
    if (isMissingRelationError(result.error, "member_login_activity")) return false;
    throw result.error;
  }

  return true;
}

export async function createReengagementAction(input: {
  memberIdentifier: string;
  fallbackEmail?: string;
  riskLevel: "Low" | "Medium" | "High";
  actionType: string;
  recommendedAction: string;
  actionNotes?: string;
  status?: "planned" | "sent" | "completed" | "dismissed";
  followUpDueAt?: string;
}) {
  const member = await findMember(input.memberIdentifier, input.fallbackEmail);
  if (!member) throw new Error("Member not found in loyalty_members.");

  const pk = getMemberPk(member);
  if (!pk) throw new Error("Member primary key is missing.");

  const authRes = await supabase.auth.getUser();
  if (authRes.error) throw authRes.error;

  const { data, error } = await supabase
    .from("member_reengagement_actions")
    .insert({
      member_id: pk.value,
      initiated_by: authRes.data.user?.id ?? null,
      risk_level: input.riskLevel,
      action_type: input.actionType,
      recommended_action: input.recommendedAction,
      action_notes: input.actionNotes ?? null,
      status: input.status ?? "planned",
      follow_up_due_at: input.followUpDueAt ?? null,
      sent_at: input.status === "sent" ? new Date().toISOString() : null,
      completed_at: input.status === "completed" ? new Date().toISOString() : null,
    })
    .select("*")
    .single();

  if (error) {
    if (isMissingRelationError(error, "member_reengagement_actions")) {
      throw new Error("Run the updated Supabase SQL first to enable re-engagement tracking.");
    }
    throw error;
  }

  return data as AnyRecord;
}

export async function updateReengagementActionOutcome(input: {
  id: number | string;
  status?: "planned" | "sent" | "completed" | "dismissed";
  success?: boolean | null;
  successMetric?: string;
  sentAt?: string | null;
  completedAt?: string | null;
}) {
  const patch: AnyRecord = {
    success: input.success ?? null,
    success_metric: input.successMetric ?? null,
  };

  if (input.status) patch.status = input.status;
  if (input.sentAt !== undefined) patch.sent_at = input.sentAt;
  if (input.completedAt !== undefined) patch.completed_at = input.completedAt;
  if (input.status === "sent" && input.sentAt === undefined) patch.sent_at = new Date().toISOString();
  if (input.status === "completed" && input.completedAt === undefined) patch.completed_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("member_reengagement_actions")
    .update(patch)
    .eq("id", input.id)
    .select("*")
    .single();

  if (error) {
    if (isMissingRelationError(error, "member_reengagement_actions")) {
      throw new Error("Run the updated Supabase SQL first to enable re-engagement tracking.");
    }
    throw error;
  }

  return data as AnyRecord;
}

export async function loadReengagementActions() {
  const { data, error } = await supabase
    .from("member_reengagement_actions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    if (isMissingRelationError(error, "member_reengagement_actions")) return [];
    throw error;
  }

  return (data || []) as AnyRecord[];
}
