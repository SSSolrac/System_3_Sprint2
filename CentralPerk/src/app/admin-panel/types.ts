export interface Member {
  member_id: string;
  id?: string | number;
  member_number: string;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string | null;
  enrollment_date: string;
  points_balance?: number;
  tier?: string;
  manual_segment?: "High Value" | "Active" | "At Risk" | "Inactive" | null;
  sms_enabled?: boolean;
  email_enabled?: boolean;
  push_enabled?: boolean;
  promotional_opt_in?: boolean;
  communication_frequency?: "daily" | "weekly" | "never";
}

export interface LoyaltyTransaction {
  transaction_id?: string;
  member_id: string;
  points: number;
  transaction_type: string;
  transaction_date: string;
  amount_spent?: number | null;
  receipt_id?: string | null;
  expiry_date?: string | null;
  reason?: string;
  description?: string;
  loyalty_members?: {
    first_name: string;
    last_name: string;
    member_number: string;
  };
}

export interface TierDistribution {
  gold: number;
  silver: number;
  bronze: number;
}

export interface MemberGrowthPoint {
  key: string;
  label: string;
  count: number;
}

export interface SeriesPoint {
  key: string;
  label: string;
  value: number;
}

export interface TierMovementPoint {
  key: string;
  label: string;
  upgrades: number;
  downgrades: number;
}

export interface MemberActivityRow {
  memberNumber: string;
  fullName: string;
  lastActivityDate: string | null;
  activityLevel: "active" | "warm" | "inactive";
  earnedPoints: number;
}

export interface RewardPopularityRow {
  label: string;
  count: number;
}

export interface PointsLot {
  id: number | string;
  member_id: string | number;
  source_transaction_id?: number | string | null;
  original_points: number;
  remaining_points: number;
  earned_at: string;
  expiry_date: string;
  created_at?: string;
}

export interface RewardCatalogRow {
  id?: number | string;
  reward_id: string;
  name: string;
  description?: string | null;
  points_cost: number;
  category?: string | null;
  image_url?: string | null;
  is_active?: boolean;
  expiry_date?: string | null;
  created_at?: string;
}

export interface MemberLoginActivity {
  id: number | string;
  member_id: string | number;
  login_at: string;
  channel?: string | null;
  source?: string | null;
  created_at?: string;
}

export interface ReengagementAction {
  id: number | string;
  member_id: string | number;
  initiated_by?: string | null;
  risk_level: "Low" | "Medium" | "High";
  action_type: string;
  recommended_action: string;
  action_notes?: string | null;
  status: "planned" | "sent" | "completed" | "dismissed";
  success?: boolean | null;
  success_metric?: string | null;
  created_at: string;
  sent_at?: string | null;
  completed_at?: string | null;
  follow_up_due_at?: string | null;
}

export interface AdminMetrics {
  totalMembers: number;
  activeMembers: number;
  pointsLiability: number;
  totalPointsRedeemed: number;
  tierDistribution: TierDistribution;
  newMembersToday: number;
  newMembersThisWeek: number;
  newMembersThisMonth: number;
  newMembersLastMonth: number;
  growthRate: number;
  growthSeries: MemberGrowthPoint[];
  earnedPointsSeries: SeriesPoint[];
  redemptionSeries: SeriesPoint[];
  memberSegments: { label: string; count: number }[];
  memberActivityRows: MemberActivityRow[];
  rewardPopularity: RewardPopularityRow[];
  redemptionRate: number;
  tierMovementTrend: TierMovementPoint[];
  redemptionValuePerPoint: number;
  monetaryLiability: number;
  liabilityTrend: { month: string; points: number; monetary: number }[];
}
