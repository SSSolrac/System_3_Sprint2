import { supabase } from "../../utils/supabase/client";
import type { MemberData } from "../types/loyalty";

const STORAGE_KEYS = {
  referrals: "centralperk-referrals-v1",
  birthdayClaims: "centralperk-birthday-claims-v1",
} as const;

export type MemberSegment = "High Value" | "Active" | "At Risk" | "Inactive";

export interface SegmentStats {
  segment: MemberSegment;
  count: number;
  share: number;
}

export interface CommunicationPreference {
  sms: boolean;
  email: boolean;
  push: boolean;
  promotionalOptIn: boolean;
  frequency: "daily" | "weekly" | "never";
}

export interface ReferralRecord {
  id: string;
  referrerMemberId: string;
  referrerCode: string;
  refereeEmail: string;
  refereeMemberId?: string;
  status: "pending" | "joined";
  createdAt: string;
  convertedAt?: string;
}

export interface FeedbackRecord {
  id: string;
  memberId: string;
  memberName: string;
  category: "points" | "rewards" | "service" | "app";
  rating: 1 | 2 | 3 | 4 | 5;
  comment: string;
  contactOptIn: boolean;
  contactInfo: string | null;
  createdAt: string;
}

function safeWindow() {
  return typeof window === "undefined" ? null : window;
}

function loadJson<T>(key: string, fallback: T): T {
  const win = safeWindow();
  if (!win) return fallback;
  try {
    const raw = win.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJson<T>(key: string, data: T) {
  const win = safeWindow();
  if (!win) return;
  win.localStorage.setItem(key, JSON.stringify(data));
}

function normalizeManualSegment(value: string): MemberSegment | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "high value") return "High Value";
  if (normalized === "active") return "Active";
  if (normalized === "at risk") return "At Risk";
  if (normalized === "inactive") return "Inactive";
  return null;
}

export async function saveManualSegment(memberNumber: string, segmentName: string) {
  const normalized = normalizeManualSegment(segmentName);
  if (!normalized) throw new Error("Manual segment must be one of: High Value, Active, At Risk, Inactive.");

  const result = await supabase
    .from("loyalty_members")
    .update({ manual_segment: normalized })
    .eq("member_number", memberNumber)
    .select("member_number")
    .limit(1)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw new Error("Member not found for manual segment update.");

  return normalized;
}

export function exportMembersCsv(rows: Array<{ memberNumber: string; name: string; email: string; phone: string; segment: string }>) {
  const headers = ["Member #", "Name", "Email", "Phone", "Segment"];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push([
      row.memberNumber,
      row.name,
      row.email,
      row.phone,
      row.segment,
    ].map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`).join(","));
  }

  const win = safeWindow();
  if (!win) return;
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `member-segments-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function buildSegmentStats(totalMembers: number, segments: string[]): SegmentStats[] {
  const base: Record<MemberSegment, number> = {
    "High Value": 0,
    Active: 0,
    "At Risk": 0,
    Inactive: 0,
  };

  for (const segment of segments) {
    if (segment in base) base[segment as MemberSegment] += 1;
  }

  return (Object.keys(base) as MemberSegment[]).map((segment) => ({
    segment,
    count: base[segment],
    share: totalMembers > 0 ? (base[segment] / totalMembers) * 100 : 0,
  }));
}

export const defaultCommunicationPreference: CommunicationPreference = {
  sms: true,
  email: true,
  push: true,
  promotionalOptIn: true,
  frequency: "weekly",
};

function toCommunicationPreference(row?: Record<string, unknown> | null): CommunicationPreference {
  if (!row) return defaultCommunicationPreference;
  const frequency = String(row.communication_frequency || "weekly").toLowerCase();
  return {
    sms: Boolean(row.sms_enabled ?? true),
    email: Boolean(row.email_enabled ?? true),
    push: Boolean(row.push_enabled ?? true),
    promotionalOptIn: Boolean(row.promotional_opt_in ?? true),
    frequency: frequency === "daily" || frequency === "never" ? frequency : "weekly",
  };
}

export async function loadCommunicationPreference(memberId: string, fallbackEmail?: string): Promise<CommunicationPreference> {
  let lookup = await supabase
    .from("loyalty_members")
    .select("sms_enabled,email_enabled,push_enabled,promotional_opt_in,communication_frequency")
    .eq("member_number", memberId)
    .limit(1)
    .maybeSingle();

  if (lookup.error) throw lookup.error;

  if (!lookup.data && fallbackEmail) {
    lookup = await supabase
      .from("loyalty_members")
      .select("sms_enabled,email_enabled,push_enabled,promotional_opt_in,communication_frequency")
      .ilike("email", fallbackEmail)
      .limit(1)
      .maybeSingle();
    if (lookup.error) throw lookup.error;
  }

  return toCommunicationPreference(lookup.data as Record<string, unknown> | null);
}

export async function saveCommunicationPreference(memberId: string, preference: CommunicationPreference, fallbackEmail?: string) {
  const payload = {
    sms_enabled: Boolean(preference.sms),
    email_enabled: Boolean(preference.email),
    push_enabled: Boolean(preference.push),
    promotional_opt_in: Boolean(preference.promotionalOptIn),
    communication_frequency: preference.frequency,
  };

  let update = await supabase
    .from("loyalty_members")
    .update(payload)
    .eq("member_number", memberId)
    .select("member_number")
    .limit(1)
    .maybeSingle();
  if (update.error) throw update.error;

  if (!update.data && fallbackEmail) {
    update = await supabase
      .from("loyalty_members")
      .update(payload)
      .ilike("email", fallbackEmail)
      .select("member_number")
      .limit(1)
      .maybeSingle();
    if (update.error) throw update.error;
  }
}

export function canSendNotificationByPreference(
  pref: CommunicationPreference,
  channel: "sms" | "email" | "push",
  isTransactional: boolean
) {
  if (isTransactional) {
    return true;
  }

  if (pref.frequency === "never") return false;
  if (!pref.promotionalOptIn) return false;
  return channel === "sms" ? pref.sms : channel === "email" ? pref.email : pref.push;
}

export function buildReferralCode(member: Pick<MemberData, "memberId" | "fullName">) {
  const token = member.fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "X")
    .join("");
  return `${token}${member.memberId.slice(-4).toUpperCase()}`;
}

export function loadReferrals(): ReferralRecord[] {
  return loadJson<ReferralRecord[]>(STORAGE_KEYS.referrals, []);
}

export function createReferral(input: { referrerMemberId: string; referrerCode: string; refereeEmail: string }) {
  const records = loadReferrals();
  const record: ReferralRecord = {
    id: crypto.randomUUID(),
    referrerMemberId: input.referrerMemberId,
    referrerCode: input.referrerCode,
    refereeEmail: input.refereeEmail.trim().toLowerCase(),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  records.unshift(record);
  saveJson(STORAGE_KEYS.referrals, records);
  return record;
}

export async function markReferralJoined(input: { referralCode: string; refereeMemberId: string; refereeEmail: string }) {
  const email = input.refereeEmail.trim().toLowerCase();
  const records = loadReferrals();
  const matched = records.find((item) => item.referrerCode === input.referralCode && item.refereeEmail === email && item.status === "pending");
  if (!matched) return null;

  matched.status = "joined";
  matched.refereeMemberId = input.refereeMemberId;
  matched.convertedAt = new Date().toISOString();
  saveJson(STORAGE_KEYS.referrals, records);

  return {
    referrerPoints: 500,
    refereePoints: 200,
    referrerMemberId: matched.referrerMemberId,
  };
}

export function getBirthdayRewardPoints(tier: MemberData["tier"]) {
  if (tier === "Gold") return 1000;
  if (tier === "Silver") return 500;
  return 100;
}

export function isBirthdayMonth(member: Pick<MemberData, "birthdate">) {
  if (!member.birthdate) return false;
  const d = new Date(member.birthdate);
  if (Number.isNaN(d.getTime())) return false;
  return d.getMonth() === new Date().getMonth();
}

export function hasBirthdayClaimedThisYear(memberId: string) {
  const claims = loadJson<Record<string, number>>(STORAGE_KEYS.birthdayClaims, {});
  return claims[memberId] === new Date().getFullYear();
}

export function markBirthdayClaimed(memberId: string) {
  const claims = loadJson<Record<string, number>>(STORAGE_KEYS.birthdayClaims, {});
  claims[memberId] = new Date().getFullYear();
  saveJson(STORAGE_KEYS.birthdayClaims, claims);
}

const feedbackCategories = new Set<FeedbackRecord["category"]>(["points", "rewards", "service", "app"]);

function normalizeFeedbackRow(row: Record<string, unknown>): FeedbackRecord {
  const category = String(row.category || "service").toLowerCase() as FeedbackRecord["category"];
  const rating = Math.max(1, Math.min(5, Number(row.rating) || 5)) as FeedbackRecord["rating"];
  return {
    id: String(row.id ?? crypto.randomUUID()),
    memberId: String(row.member_number ?? row.member_id ?? ""),
    memberName: String(row.member_name ?? ""),
    category: feedbackCategories.has(category) ? category : "service",
    rating,
    comment: String(row.comment ?? ""),
    contactOptIn: Boolean(row.contact_opt_in),
    contactInfo: row.contact_info ? String(row.contact_info) : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
  };
}

export async function submitFeedback(entry: Omit<FeedbackRecord, "id" | "createdAt">) {
  if (!feedbackCategories.has(entry.category)) {
    throw new Error("Feedback category must be one of: points, rewards, service, app.");
  }
  if (entry.rating < 1 || entry.rating > 5) {
    throw new Error("Rating must be between 1 and 5.");
  }
  const comment = entry.comment.trim();
  if (!comment) {
    throw new Error("Feedback comment is required.");
  }
  if (comment.length > 500) {
    throw new Error("Feedback comment must be 500 characters or less.");
  }

  const { data, error } = await supabase
    .from("member_feedback")
    .insert({
      member_number: entry.memberId,
      member_name: entry.memberName.trim(),
      category: entry.category,
      rating: entry.rating,
      comment,
      contact_opt_in: Boolean(entry.contactOptIn),
      contact_info: entry.contactInfo?.trim() ? entry.contactInfo.trim() : null,
    })
    .select("id,member_number,member_name,category,rating,comment,contact_opt_in,contact_info,created_at")
    .single();
  if (error) throw error;
  return normalizeFeedbackRow((data ?? {}) as Record<string, unknown>);
}

export async function loadFeedback(): Promise<FeedbackRecord[]> {
  const { data, error } = await supabase
    .from("member_feedback")
    .select("id,member_number,member_name,category,rating,comment,contact_opt_in,contact_info,created_at")
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data || []).map((row) => normalizeFeedbackRow(row as Record<string, unknown>));
}

export async function queueManagerFeedbackNotification(record: FeedbackRecord) {
  const admins = await supabase
    .from("app_user_roles")
    .select("user_id")
    .eq("role", "admin");
  if (admins.error) throw admins.error;
  const rows = (admins.data || [])
    .map((item) => String(item.user_id || "").trim())
    .filter(Boolean)
    .map((userId) => ({
      user_id: userId,
      channel: "email" as const,
      subject: `New feedback: ${record.category}`,
      message: `${record.memberName} rated ${record.rating}/5. ${record.comment.slice(0, 180)}`,
      is_promotional: false,
    }));
  if (rows.length === 0) return;

  const res = await supabase.from("notification_outbox").insert(rows);
  if (res.error) throw res.error;
}
