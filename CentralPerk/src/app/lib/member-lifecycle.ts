import { supabase } from "../../utils/supabase/client";
import type { Member } from "../admin-panel/types";
import type { MemberData } from "../types/loyalty";

const STORAGE_KEYS = {
  referrals: "centralperk-referrals-v1",
  birthdayClaims: "centralperk-birthday-claims-v1",
  feedback: "centralperk-feedback-v1",
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

function daysSince(value?: string | null) {
  if (!value) return Number.POSITIVE_INFINITY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

export function deriveAutoSegment(member: Member, lastActivityDate?: string | null): MemberSegment {
  const balance = Number(member.points_balance || 0);
  const inactiveDays = daysSince(lastActivityDate ?? member.enrollment_date);
  const tier = String(member.tier || "Bronze").toLowerCase();
  if (balance >= 2500 || (tier === "gold" && balance >= 1200)) return "High Value";
  if (inactiveDays <= 30) return "Active";
  if (inactiveDays <= 90) return "At Risk";
  return "Inactive";
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
    return channel === "sms" ? pref.sms : channel === "email" ? pref.email : pref.push;
  }

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

export function submitFeedback(entry: Omit<FeedbackRecord, "id" | "createdAt">) {
  const record: FeedbackRecord = { ...entry, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  const rows = loadJson<FeedbackRecord[]>(STORAGE_KEYS.feedback, []);
  rows.unshift(record);
  saveJson(STORAGE_KEYS.feedback, rows);
  return record;
}

export function loadFeedback(): FeedbackRecord[] {
  return loadJson<FeedbackRecord[]>(STORAGE_KEYS.feedback, []);
}

export async function queueManagerFeedbackNotification(record: FeedbackRecord) {
  const res = await supabase.from("notification_outbox").insert({
    user_id: null,
    channel: "email",
    subject: `New feedback: ${record.category}`,
    message: `${record.memberName} rated ${record.rating}/5. ${record.comment.slice(0, 180)}`,
  });
  if (res.error) throw res.error;
}
