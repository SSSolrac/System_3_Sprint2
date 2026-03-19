import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../../utils/supabase/client";
import type {
  AdminMetrics,
  LoyaltyTransaction,
  MemberLoginActivity,
  Member,
  MemberActivityRow,
  MemberGrowthPoint,
  PointsLot,
  RewardPopularityRow,
  RewardCatalogRow,
  ReengagementAction,
  SeriesPoint,
  TierDistribution,
  TierMovementPoint,
} from "../types";
import {
  fetchActiveEarningRules,
  fetchTierRules,
  processAllMemberExpiredPoints,
  type EarningRule,
} from "../../lib/loyalty-supabase";
import { resolveTier, type TierRule } from "../../lib/loyalty-engine";
import { buildAdvancedAnalyticsDatasets } from "../lib/advanced-insights";

type TierHistoryRow = {
  old_tier?: string | null;
  new_tier?: string | null;
  changed_at: string;
};

type MemberSegmentRow = {
  member_id: string | number;
  member_number: string;
  auto_segment: string | null;
  manual_segment: string | null;
  effective_segment: string | null;
  last_activity_at: string | null;
};

function transactionLabel(tx: LoyaltyTransaction) {
  return String(tx.reason ?? tx.description ?? "").trim();
}

function startOfWeek(date: Date) {
  const next = new Date(date);
  const day = next.getDay();
  const diff = (day + 6) % 7;
  next.setDate(next.getDate() - diff);
  next.setHours(0, 0, 0, 0);
  return next;
}

function monthLabel(date: Date) {
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}`;
}

function parseDate(value?: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function txType(value: string) {
  const normalized = String(value || "").toUpperCase();
  if (normalized.includes("REDEEM")) return "redeemed";
  if (normalized.includes("EXPIRY")) return "expired";
  return "earned";
}

function isMissingRelationError(error: unknown, table: string) {
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

export function useAdminData() {
  const [members, setMembers] = useState<Member[]>([]);
  const [redemptions, setRedemptions] = useState<LoyaltyTransaction[]>([]);
  const [transactions, setTransactions] = useState<LoyaltyTransaction[]>([]);
  const [tierHistory, setTierHistory] = useState<TierHistoryRow[]>([]);
  const [pointsLots, setPointsLots] = useState<PointsLot[]>([]);
  const [rewardsCatalog, setRewardsCatalog] = useState<RewardCatalogRow[]>([]);
  const [loginActivity, setLoginActivity] = useState<MemberLoginActivity[]>([]);
  const [reengagementActions, setReengagementActions] = useState<ReengagementAction[]>([]);
  const [tierRules, setTierRules] = useState<TierRule[]>([]);
  const [earningRules, setEarningRules] = useState<EarningRule[]>([]);
  const [redemptionValuePerPoint, setRedemptionValuePerPoint] = useState<number>(0.01);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      try {
        await processAllMemberExpiredPoints();
      } catch (expiryErr) {
        console.warn("Expiry processing failed in admin fetch:", expiryErr);
      }

      const [
        membersRes,
        memberSegmentsRes,
        redemptionsRes,
        transactionsRes,
        tierHistoryRes,
        pointsLotsRes,
        rewardsCatalogRes,
        loginActivityRes,
        reengagementActionsRes,
        rules,
        earningRulesRes,
        redemptionSettingsRes,
      ] = await Promise.all([
        supabase.from("loyalty_members").select("*").order("enrollment_date", { ascending: false }),
        supabase.rpc("loyalty_member_segments"),
        supabase.from("loyalty_transactions").select("*").eq("transaction_type", "REDEEM"),
        supabase
          .from("loyalty_transactions")
          .select("*, loyalty_members(first_name, last_name, member_number)")
          .order("transaction_date", { ascending: false }),
        supabase.from("tier_history").select("old_tier,new_tier,changed_at").order("changed_at", { ascending: false }).limit(500),
        supabase.from("points_lots").select("*").order("expiry_date", { ascending: true }),
        supabase.from("rewards_catalog").select("*").order("points_cost", { ascending: true }),
        supabase.from("member_login_activity").select("*").order("login_at", { ascending: false }).limit(5000),
        supabase.from("member_reengagement_actions").select("*").order("created_at", { ascending: false }).limit(5000),
        fetchTierRules(),
        fetchActiveEarningRules(),
        supabase
          .from("redemption_settings")
          .select("redemption_value_per_point")
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (membersRes.error) throw membersRes.error;
      if (memberSegmentsRes.error) throw memberSegmentsRes.error;
      if (transactionsRes.error) throw transactionsRes.error;
      if (pointsLotsRes.error && !isMissingRelationError(pointsLotsRes.error, "points_lots")) throw pointsLotsRes.error;
      if (rewardsCatalogRes.error && !isMissingRelationError(rewardsCatalogRes.error, "rewards_catalog")) throw rewardsCatalogRes.error;
      if (loginActivityRes.error && !isMissingRelationError(loginActivityRes.error, "member_login_activity")) throw loginActivityRes.error;
      if (reengagementActionsRes.error && !isMissingRelationError(reengagementActionsRes.error, "member_reengagement_actions")) {
        throw reengagementActionsRes.error;
      }

      const segmentRows = (memberSegmentsRes.data || []) as MemberSegmentRow[];
      const segmentByMemberId = new Map<string, MemberSegmentRow>();
      const segmentByMemberNumber = new Map<string, MemberSegmentRow>();
      for (const row of segmentRows) {
        const memberIdKey = String(row.member_id ?? "");
        const memberNumberKey = String(row.member_number ?? "");
        if (memberIdKey) segmentByMemberId.set(memberIdKey, row);
        if (memberNumberKey) segmentByMemberNumber.set(memberNumberKey, row);
      }

      const membersWithSegments = ((membersRes.data || []) as Member[]).map((member) => {
        const byId = segmentByMemberId.get(String(member.id ?? member.member_id ?? ""));
        const byNumber = segmentByMemberNumber.get(String(member.member_number ?? ""));
        const segment = byId || byNumber;
        if (!segment) return member;
        return {
          ...member,
          auto_segment: (segment.auto_segment as Member["auto_segment"]) ?? null,
          manual_segment: (segment.manual_segment as Member["manual_segment"]) ?? null,
          effective_segment: (segment.effective_segment as Member["effective_segment"]) ?? null,
          last_activity_at: segment.last_activity_at ?? null,
        };
      });

      setMembers(membersWithSegments);
      setRedemptions(redemptionsRes.error ? [] : ((redemptionsRes.data || []) as LoyaltyTransaction[]));
      setTransactions((transactionsRes.data || []) as LoyaltyTransaction[]);
      setTierHistory((tierHistoryRes.error ? [] : tierHistoryRes.data || []) as TierHistoryRow[]);
      setPointsLots(
        pointsLotsRes.error
          ? []
          : ((pointsLotsRes.data || []) as PointsLot[])
      );
      setRewardsCatalog(
        rewardsCatalogRes.error
          ? []
          : ((rewardsCatalogRes.data || []) as RewardCatalogRow[])
      );
      setLoginActivity(
        loginActivityRes.error
          ? []
          : ((loginActivityRes.data || []) as MemberLoginActivity[])
      );
      setReengagementActions(
        reengagementActionsRes.error
          ? []
          : ((reengagementActionsRes.data || []) as ReengagementAction[])
      );
      setTierRules(rules);
      setEarningRules(earningRulesRes);

      const rawRate = redemptionSettingsRes.data?.redemption_value_per_point;
      const parsedRate = Number(rawRate ?? 0.01);
      setRedemptionValuePerPoint(Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 0.01);
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : e && typeof e === "object" && "message" in e
          ? String((e as { message?: unknown }).message ?? "Failed to load admin data.")
          : "Failed to load admin data.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const metrics = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = startOfWeek(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const growthSeries: MemberGrowthPoint[] = [];
    const earnedPointsSeries: SeriesPoint[] = [];
    const redemptionSeries: SeriesPoint[] = [];
    const tierMovementTrend: TierMovementPoint[] = [];

    for (let offset = 5; offset >= 0; offset -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const key = monthKey(date);
      const label = monthLabel(date);
      growthSeries.push({ key, label, count: 0 });
      earnedPointsSeries.push({ key, label, value: 0 });
      redemptionSeries.push({ key, label, value: 0 });
      tierMovementTrend.push({ key, label, upgrades: 0, downgrades: 0 });
    }

    const latestTxByMember = new Map<string, Date>();
    for (const tx of transactions) {
      const parsed = parseDate(tx.transaction_date);
      if (!parsed) continue;
      const existing = latestTxByMember.get(String(tx.member_id));
      if (!existing || parsed > existing) latestTxByMember.set(String(tx.member_id), parsed);

      const monthlyPoint = growthSeries.find((point) => point.key === monthKey(parsed));
      if (!monthlyPoint) continue;

      const seriesPoint = txType(tx.transaction_type) === "redeemed" ? redemptionSeries : earnedPointsSeries;
      const match = seriesPoint.find((point) => point.key === monthKey(parsed));
      if (!match) continue;

      if (txType(tx.transaction_type) === "redeemed") {
        match.value += Math.abs(Number(tx.points || 0));
      } else if (Number(tx.points || 0) > 0) {
        match.value += Number(tx.points || 0);
      }
    }

    for (const member of members) {
      const joined = parseDate(member.enrollment_date);
      if (!joined) continue;
      const point = growthSeries.find((entry) => entry.key === monthKey(joined));
      if (point) point.count += 1;
    }

    for (const row of tierHistory) {
      const changed = parseDate(row.changed_at);
      if (!changed) continue;
      const point = tierMovementTrend.find((entry) => entry.key === monthKey(changed));
      if (!point) continue;
      const oldTier = String(row.old_tier || "").toLowerCase();
      const newTier = String(row.new_tier || "").toLowerCase();
      const rank = (tier: string) => (tier === "gold" ? 3 : tier === "silver" ? 2 : tier === "bronze" ? 1 : 0);
      if (rank(newTier) > rank(oldTier)) point.upgrades += 1;
      if (rank(newTier) < rank(oldTier)) point.downgrades += 1;
    }

    const totalMembers = members.length;
    const pointsLiability = members.reduce((sum, member) => sum + Number(member.points_balance || 0), 0);
    const totalPointsRedeemed = redemptions.reduce((sum, tx) => sum + Math.abs(Number(tx.points || 0)), 0);

    const activeMembers = members.filter((member) => {
      const memberKey = String(member.id ?? member.member_id ?? "");
      const lastTx = latestTxByMember.get(memberKey);
      return lastTx ? now.getTime() - lastTx.getTime() <= 30 * 24 * 60 * 60 * 1000 : false;
    }).length;

    const tierDistribution: TierDistribution = members.reduce(
      (acc, member) => {
        const balance = Number(member.points_balance || 0);
        const tier = resolveTier(balance, tierRules).toLowerCase();
        if (tier === "gold") acc.gold += 1;
        else if (tier === "silver") acc.silver += 1;
        else acc.bronze += 1;
        return acc;
      },
      { gold: 0, silver: 0, bronze: 0 }
    );

    const newMembersToday = members.filter((member) => {
      const joined = parseDate(member.enrollment_date);
      return joined ? joined >= todayStart : false;
    }).length;

    const newMembersThisWeek = members.filter((member) => {
      const joined = parseDate(member.enrollment_date);
      return joined ? joined >= weekStart : false;
    }).length;

    const newMembersThisMonth = members.filter((member) => {
      const joined = parseDate(member.enrollment_date);
      return joined ? joined >= monthStart : false;
    }).length;

    const previousMonthKey = growthSeries[growthSeries.length - 2]?.key;
    const newMembersLastMonth = previousMonthKey
      ? growthSeries.find((point) => point.key === previousMonthKey)?.count ?? 0
      : 0;
    const growthRate =
      newMembersLastMonth > 0
        ? ((newMembersThisMonth - newMembersLastMonth) / newMembersLastMonth) * 100
        : newMembersThisMonth > 0
        ? 100
        : 0;

    const memberSegments = [
      {
        label: "Active (30d)",
        count: members.filter((member) => {
          const key = String(member.id ?? member.member_id ?? "");
          const lastTx = latestTxByMember.get(key);
          return lastTx ? now.getTime() - lastTx.getTime() <= 30 * 24 * 60 * 60 * 1000 : false;
        }).length,
      },
      {
        label: "Warm (31-90d)",
        count: members.filter((member) => {
          const key = String(member.id ?? member.member_id ?? "");
          const lastTx = latestTxByMember.get(key);
          if (!lastTx) return false;
          const age = now.getTime() - lastTx.getTime();
          return age > 30 * 24 * 60 * 60 * 1000 && age <= 90 * 24 * 60 * 60 * 1000;
        }).length,
      },
      {
        label: "Dormant (90d+)",
        count: members.filter((member) => {
          const key = String(member.id ?? member.member_id ?? "");
          const lastTx = latestTxByMember.get(key);
          if (!lastTx) return true;
          return now.getTime() - lastTx.getTime() > 90 * 24 * 60 * 60 * 1000;
        }).length,
      },
    ];

    const memberActivityRows: MemberActivityRow[] = members.map((member) => {
      const memberKey = String(member.id ?? member.member_id ?? "");
      const lastTx = latestTxByMember.get(memberKey);
      const earnedPoints = transactions
        .filter((tx) => String(tx.member_id) === memberKey && txType(tx.transaction_type) === "earned" && Number(tx.points || 0) > 0)
        .reduce((sum, tx) => sum + Number(tx.points || 0), 0);

      let activityLevel: MemberActivityRow["activityLevel"] = "inactive";
      if (lastTx) {
        const ageDays = (now.getTime() - lastTx.getTime()) / (1000 * 60 * 60 * 24);
        if (ageDays <= 30) activityLevel = "active";
        else if (ageDays <= 90) activityLevel = "warm";
      }

      return {
        memberNumber: member.member_number || "N/A",
        fullName: `${member.first_name} ${member.last_name}`.trim(),
        lastActivityDate: lastTx ? lastTx.toISOString() : null,
        activityLevel,
        earnedPoints,
      };
    });

    const rewardPopularityMap = new Map<string, number>();
    for (const tx of transactions) {
      if (txType(tx.transaction_type) !== "redeemed") continue;
      const label = transactionLabel(tx) || "General Reward";
      rewardPopularityMap.set(label, (rewardPopularityMap.get(label) || 0) + 1);
    }
    const rewardPopularity: RewardPopularityRow[] = Array.from(rewardPopularityMap.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const totalEarnedPoints = transactions
      .filter((tx) => txType(tx.transaction_type) === "earned" && Number(tx.points || 0) > 0)
      .reduce((sum, tx) => sum + Number(tx.points || 0), 0);
    const redemptionRate =
      totalEarnedPoints > 0 ? Number(((totalPointsRedeemed / totalEarnedPoints) * 100).toFixed(2)) : 0;

    const monetaryLiability = Number((pointsLiability * redemptionValuePerPoint).toFixed(2));
    const liabilityTrend = growthSeries.map((point) => {
      const monthMembers = members.filter((member) => {
        const joined = parseDate(member.enrollment_date);
        return joined ? monthKey(joined) <= point.key : false;
      });
      const monthPoints = monthMembers.reduce((sum, member) => sum + Number(member.points_balance || 0), 0);
      return {
        month: point.label,
        points: monthPoints,
        monetary: Number((monthPoints * redemptionValuePerPoint).toFixed(2)),
      };
    });

    return {
      totalMembers,
      activeMembers,
      pointsLiability,
      totalPointsRedeemed,
      tierDistribution,
      newMembersToday,
      newMembersThisWeek,
      newMembersThisMonth,
      newMembersLastMonth,
      growthRate,
      growthSeries,
      earnedPointsSeries,
      redemptionSeries,
      memberSegments,
      memberActivityRows,
      rewardPopularity,
      redemptionRate,
      tierMovementTrend,
      redemptionValuePerPoint,
      monetaryLiability,
      liabilityTrend,
    } satisfies AdminMetrics;
  }, [members, redemptions, transactions, tierHistory, tierRules, redemptionValuePerPoint]);

  const insights = useMemo(
    () =>
      buildAdvancedAnalyticsDatasets({
        members,
        transactions,
        pointsLots,
        rewardsCatalog,
        loginActivity,
        reengagementActions,
        tierRules,
        redemptionValuePerPoint,
      }),
    [members, transactions, pointsLots, rewardsCatalog, loginActivity, reengagementActions, tierRules, redemptionValuePerPoint]
  );

  return {
    members,
    transactions,
    pointsLots,
    rewardsCatalog,
    loginActivity,
    reengagementActions,
    loading,
    error,
    metrics,
    insights,
    tierRules,
    earningRules,
    redemptionValuePerPoint,
    refetch: fetchData,
  };
}
