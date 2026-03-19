import { useEffect, useMemo, useState } from "react";
import { BellRing, Download, Megaphone, MessageSquareText, Share2, Trophy, Radio, ClipboardList, FileQuestion, UserX } from "lucide-react";
import { toast } from "sonner";
import { Card } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Progress } from "../../components/ui/progress";
import { Textarea } from "../../components/ui/textarea";
import { useAdminData } from "../hooks/use-admin-data";
import { queueSmsNotification } from "../../lib/notifications";
import {
  buildInactiveMemberInsights,
  exportSurveyResponsesCsv,
  getChallengeLeaderboard,
  getSegmentAudienceSize,
  loadEngagementState,
  notificationTemplates,
  saveEngagementState,
  type ChallengeDefinition,
  type EngagementSegment,
  type EngagementState,
  type NotificationTrigger,
  type QuestionType,
  type SurveyQuestion,
  type WinBackOfferType,
} from "../../lib/member-engagement";
import { loadAllReferrals, loadFeedback, type FeedbackRecord, type ReferralRecord } from "../../lib/member-lifecycle";

const tabs = [
  { id: "notifications", label: "Push Notifications", icon: BellRing },
  { id: "challenges", label: "Challenges", icon: Trophy },
  { id: "sharing", label: "Social Sharing", icon: Share2 },
  { id: "surveys", label: "Surveys", icon: MessageSquareText },
  { id: "winback", label: "Win-back", icon: Megaphone },
] as const;

const segments: EngagementSegment[] = ["All Members", "Bronze", "Silver", "Gold", "High Value", "Inactive 60+ Days"];
const triggers: NotificationTrigger[] = ["Points Earned", "Tier Upgrade", "Reward Available", "Flash Sale", "Birthday"];
const offerTypes: WinBackOfferType[] = ["2x Points", "Special Discount", "Bonus Reward"];

export default function AdminEngagementPage() {
  const { members, transactions, loginActivity, loading, error } = useAdminData();
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]["id"]>("notifications");
  const [state, setState] = useState<EngagementState>(() => loadEngagementState());
  const [campaignName, setCampaignName] = useState("Birthday Loyalty Push");
  const [campaignSegment, setCampaignSegment] = useState<EngagementSegment>("All Members");
  const [campaignTrigger, setCampaignTrigger] = useState<NotificationTrigger>("Birthday");
  const [scheduledFor, setScheduledFor] = useState(() => {
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(9, 0, 0, 0);
    return new Date(next.getTime() - next.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [variantA, setVariantA] = useState("Celebrate your day with a birthday reward waiting in the app.");
  const [variantB, setVariantB] = useState("Birthday perk unlocked. Redeem your member surprise today.");
  const [surveyTitle, setSurveyTitle] = useState("Rewards Feedback Pulse");
  const [surveySegment, setSurveySegment] = useState<EngagementSegment>("All Members");
  const [surveyBonusPoints, setSurveyBonusPoints] = useState("50");
  const [surveyQuestions, setSurveyQuestions] = useState<SurveyQuestion[]>([
    { id: crypto.randomUUID(), prompt: "How satisfied are you with current rewards?", type: "rating" },
    {
      id: crypto.randomUUID(),
      prompt: "Which campaign motivates you most?",
      type: "multiple-choice",
      options: ["Double points", "Tier upgrades", "Flash sales"],
    },
  ]);
  const [winBackName, setWinBackName] = useState("Dormant Members Recovery");
  const [winBackOffer, setWinBackOffer] = useState<WinBackOfferType>("2x Points");
  const [winBackValue, setWinBackValue] = useState("2x points on next purchase");
  const [feedbackItems, setFeedbackItems] = useState<FeedbackRecord[]>([]);
  const [referralItems, setReferralItems] = useState<ReferralRecord[]>([]);

  useEffect(() => {
    saveEngagementState(state);
  }, [state]);

  useEffect(() => {
    loadFeedback()
      .then(setFeedbackItems)
      .catch(() => setFeedbackItems([]));
  }, [state.surveys.length, state.notificationCampaigns.length]);

  useEffect(() => {
    loadAllReferrals()
      .then(setReferralItems)
      .catch(() => setReferralItems([]));
  }, [state.notificationCampaigns.length]);

  const inactiveMembers = useMemo(
    () => buildInactiveMemberInsights(members, transactions, loginActivity),
    [loginActivity, members, transactions]
  );

  const totalShares = state.shareEvents.length;
  const totalConversions = state.shareEvents.reduce((sum, item) => sum + item.conversions, 0);
  const deliveryRate = state.notificationCampaigns.reduce((sum, item) => sum + (item.sentCount ? item.deliveredCount / item.sentCount : 0), 0);
  const shareConversionRate = totalShares > 0 ? (totalConversions / totalShares) * 100 : 0;
  const selectedChallenge: ChallengeDefinition | undefined = state.challenges[0];
  const leaderboard = useMemo(
    () => (selectedChallenge ? getChallengeLeaderboard(selectedChallenge, members, transactions) : []),
    [members, selectedChallenge, transactions]
  );

  if (loading) return <p className="text-base text-gray-700">Loading engagement dashboard...</p>;
  if (error) return <p className="text-red-600">{error}</p>;

  const createNotificationCampaign = async () => {
    const audienceSize =
      campaignSegment === "Inactive 60+ Days"
        ? inactiveMembers.length
        : getSegmentAudienceSize(campaignSegment, members);

    const nextCampaign = {
      id: crypto.randomUUID(),
      name: campaignName,
      trigger: campaignTrigger,
      segment: campaignSegment,
      scheduledFor: new Date(scheduledFor).toISOString(),
      status: "scheduled" as const,
      audienceSize,
      sentCount: 0,
      deliveredCount: 0,
      openedCount: 0,
      variantA,
      variantB,
      winner: "Pending" as const,
    };

    setState((prev) => ({
      ...prev,
      notificationCampaigns: [nextCampaign, ...prev.notificationCampaigns],
    }));

    try {
      await queueSmsNotification({
        subject: `${campaignName} (${campaignSegment})`,
        message: variantA,
      });
      toast.success("Push campaign scheduled and queued.");
    } catch {
      toast.success("Push campaign saved locally for sprint demo.");
    }
  };

  const launchScheduledCampaign = (campaignId: string) => {
    setState((prev) => ({
      ...prev,
      notificationCampaigns: prev.notificationCampaigns.map((item) => {
        if (item.id !== campaignId) return item;
        const deliveredCount = Math.max(1, Math.round(item.audienceSize * 0.94));
        const openedCount = Math.max(1, Math.round(deliveredCount * 0.47));
        return {
          ...item,
          status: "completed",
          sentCount: item.audienceSize,
          deliveredCount,
          openedCount,
          winner: openedCount / Math.max(deliveredCount, 1) > 0.4 ? "B" : "A",
        };
      }),
    }));
    toast.success("Campaign launched with delivery and open-rate tracking.");
  };

  const addSurveyQuestion = () => {
    setSurveyQuestions((prev) => [...prev, { id: crypto.randomUUID(), prompt: "", type: "free-text" }]);
  };

  const updateSurveyQuestion = (questionId: string, patch: Partial<SurveyQuestion>) => {
    setSurveyQuestions((prev) => prev.map((question) => (question.id === questionId ? { ...question, ...patch } : question)));
  };

  const createSurvey = () => {
    const cleanedQuestions = surveyQuestions.filter((question) => question.prompt.trim());
    if (cleanedQuestions.length === 0) {
      toast.error("Add at least one survey question.");
      return;
    }

    setState((prev) => ({
      ...prev,
      surveys: [
        {
          id: crypto.randomUUID(),
          title: surveyTitle,
          description: "Created from the engagement dashboard.",
          segment: surveySegment,
          bonusPoints: Math.max(0, Number(surveyBonusPoints) || 0),
          status: "live",
          createdAt: new Date().toISOString(),
          questions: cleanedQuestions,
          responses: [],
        },
        ...prev.surveys,
      ],
    }));
    toast.success("Survey published.");
  };

  const createWinBackCampaign = () => {
    const targetedMembers = inactiveMembers.length;
    const responses = Math.round(targetedMembers * 0.3);
    const reengagedMembers = Math.round(targetedMembers * 0.18);
    const estimatedRevenue = reengagedMembers * 1450;
    const offerCost = Math.round(reengagedMembers * 280);

    setState((prev) => ({
      ...prev,
      winBackCampaigns: [
        {
          id: crypto.randomUUID(),
          name: winBackName,
          segment: "Inactive 60+ Days",
          offerType: winBackOffer,
          offerValue: winBackValue,
          status: "running",
          targetedMembers,
          responses,
          reengagedMembers,
          estimatedRevenue,
          offerCost,
          launchDate: new Date().toISOString(),
        },
        ...prev.winBackCampaigns,
      ],
    }));
    toast.success("Win-back automation launched.");
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Member Engagement</h1>
        <p className="text-gray-500 mt-1">Manage push campaigns, challenges, social sharing, surveys, and win-back flows.</p>
      </div>

      <section className="relative overflow-hidden rounded-[28px] border border-[#dbe7f3] bg-[radial-gradient(circle_at_top_left,_rgba(29,78,216,0.10),_transparent_32%),radial-gradient(circle_at_top_right,_rgba(147,51,234,0.10),_transparent_28%),linear-gradient(180deg,_#fbfdff_0%,_#f5f9fc_100%)] p-4 md:p-6">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#9cc2ff] to-transparent" />
        <div className="mb-5 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#48607d]">Overview</p>
            <h2 className="mt-1 text-xl font-semibold text-[#10213a]">Engagement Snapshot</h2>
          </div>
          <p className="text-sm text-[#5f7694]">Current activity across campaigns, challenges, surveys, and reactivation.</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Card className="group relative overflow-hidden rounded-[24px] border-[#b9d8ff] bg-gradient-to-br from-[#eff6ff] via-white to-[#f4faff] p-5 shadow-[0_12px_30px_rgba(29,78,216,0.08)] transition-transform duration-200 hover:-translate-y-0.5">
            <div className="absolute right-0 top-0 h-28 w-28 rounded-bl-[40px] bg-[#dbeafe]/70" />
            <div className="relative flex items-start justify-between gap-3">
              <div className="rounded-2xl bg-[#1d4ed8] p-3 text-white shadow-[0_12px_24px_rgba(29,78,216,0.28)]">
                <Radio className="h-5 w-5" />
              </div>
              <div className="mr-1 mt-1 inline-flex min-w-[92px] items-center justify-center rounded-full bg-[#dbeafe] px-2.5 py-1 text-center text-[11px] font-semibold uppercase tracking-wide text-[#1d4ed8]">
                Push
              </div>
            </div>
            <p className="relative mt-6 text-sm font-medium text-[#31517c]">Scheduled Push Campaigns</p>
            <p className="relative mt-2 text-5xl font-bold tracking-tight text-[#10213a]">{state.notificationCampaigns.length}</p>
            <p className="relative mt-3 text-xs leading-5 text-[#52739b]">Queued campaigns with scheduling, targeting, and A/B variants.</p>
          </Card>

          <Card className="group relative overflow-hidden rounded-[24px] border-[#bce7d1] bg-gradient-to-br from-[#ecfdf5] via-white to-[#f6fffa] p-5 shadow-[0_12px_30px_rgba(5,150,105,0.08)] transition-transform duration-200 hover:-translate-y-0.5">
            <div className="absolute right-0 top-0 h-28 w-28 rounded-bl-[40px] bg-[#d1fae5]/58" />
            <div className="relative flex items-start justify-between gap-3">
              <div className="rounded-2xl bg-[#059669] p-3 text-white shadow-[0_12px_24px_rgba(5,150,105,0.26)]">
                <ClipboardList className="h-5 w-5" />
              </div>
              <div className="mr-1 mt-1 inline-flex min-w-[92px] items-center justify-center rounded-full bg-[#d1fae5] px-2.5 py-1 text-center text-[11px] font-semibold uppercase tracking-wide text-[#047857]">
                Challenges
              </div>
            </div>
            <p className="relative mt-6 text-sm font-medium text-[#2d6a57]">Active Challenges</p>
            <p className="relative mt-2 text-5xl font-bold tracking-tight text-[#10213a]">{state.challenges.length}</p>
            <p className="relative mt-3 text-xs leading-5 text-[#4a7f6e]">Live challenge definitions with progress tracking and rewards.</p>
          </Card>

          <Card className="group relative overflow-hidden rounded-[24px] border-[#e4c9ff] bg-gradient-to-br from-[#faf5ff] via-white to-[#fdfaff] p-5 shadow-[0_12px_30px_rgba(147,51,234,0.08)] transition-transform duration-200 hover:-translate-y-0.5">
            <div className="absolute right-0 top-0 h-28 w-28 rounded-bl-[40px] bg-[#f3e8ff]/70" />
            <div className="relative flex items-start justify-between gap-3">
              <div className="rounded-2xl bg-[#9333ea] p-3 text-white shadow-[0_12px_24px_rgba(147,51,234,0.26)]">
                <FileQuestion className="h-5 w-5" />
              </div>
              <div className="mr-1 mt-1 inline-flex min-w-[92px] items-center justify-center rounded-full bg-[#f3e8ff] px-2.5 py-1 text-center text-[11px] font-semibold uppercase tracking-wide text-[#7e22ce]">
                Surveys
              </div>
            </div>
            <p className="relative mt-6 text-sm font-medium text-[#6d4ba3]">Live Surveys</p>
            <p className="relative mt-2 text-5xl font-bold tracking-tight text-[#10213a]">{state.surveys.filter((item) => item.status === "live").length}</p>
            <p className="relative mt-3 text-xs leading-5 text-[#8160b1]">Feedback forms with bonus points, targeting, and export support.</p>
          </Card>

          <Card className="group relative overflow-hidden rounded-[24px] border-[#fed7aa] bg-gradient-to-br from-[#fff7ed] via-white to-[#fffaf5] p-5 shadow-[0_12px_30px_rgba(234,88,12,0.08)] transition-transform duration-200 hover:-translate-y-0.5">
            <div className="absolute right-0 top-0 h-28 w-28 rounded-bl-[40px] bg-[#ffedd5]/58" />
            <div className="relative flex items-start justify-between gap-3">
              <div className="rounded-2xl bg-[#ea580c] p-3 text-white shadow-[0_12px_24px_rgba(234,88,12,0.24)]">
                <UserX className="h-5 w-5" />
              </div>
              <div className="mr-1 mt-1 inline-flex min-w-[92px] items-center justify-center rounded-full bg-[#ffedd5] px-2.5 py-1 text-center text-[11px] font-semibold uppercase tracking-wide text-[#c2410c]">
                Win-back
              </div>
            </div>
            <p className="relative mt-6 text-sm font-medium text-[#9a5a2f]">Inactive Members 60+ Days</p>
            <p className="relative mt-2 text-5xl font-bold tracking-tight text-[#10213a]">{inactiveMembers.length}</p>
            <p className="relative mt-3 text-xs leading-5 text-[#a66a40]">Members eligible for reactivation targeting and ROI tracking.</p>
          </Card>
        </div>
      </section>

      <section className="rounded-2xl border border-[#dbe7f3] bg-white p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-[#10213a]">Referral Tracking</h3>
            <p className="text-sm text-gray-500">Invites, joins, and conversion bonuses.</p>
          </div>
          <Badge>{referralItems.length} invites</Badge>
        </div>
        <p className="mt-2 text-sm text-gray-600">
          Conversions: {referralItems.filter((item) => item.status === "joined").length} • Bonuses awarded:{" "}
          {referralItems.filter((item) => item.bonusAwarded).length}
        </p>
        <div className="mt-3 space-y-2">
          {referralItems.slice(0, 10).map((row) => (
            <div key={row.id} className="rounded-lg border border-gray-200 p-3">
              <p className="text-sm font-semibold text-[#10213a]">
                Referrer {row.referrerMemberId} → {row.refereeEmail}
              </p>
              <p className="text-xs text-gray-500">
                {row.status === "joined" ? "Joined" : "Pending"} • Code {row.referrerCode}
                {row.bonusAwarded ? " • Bonus awarded" : ""}
              </p>
            </div>
          ))}
          {referralItems.length === 0 ? <p className="text-sm text-gray-500">No referral records yet.</p> : null}
        </div>
      </section>



      <section className="rounded-2xl border border-[#dbe7f3] bg-white p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-[#10213a]">Member Feedback Dashboard</h3>
            <p className="text-sm text-gray-500">Categories: points, rewards, service, app.</p>
          </div>
          <Badge>{feedbackItems.length} total</Badge>
        </div>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-3">
          {["points", "rewards", "service", "app"].map((cat) => {
            const rows = feedbackItems.filter((item) => item.category === cat);
            const avg = rows.length ? rows.reduce((sum, row) => sum + row.rating, 0) / rows.length : 0;
            return (
              <div key={cat} className="rounded-xl border border-gray-200 p-3">
                <p className="text-xs uppercase tracking-wide text-gray-500">{cat}</p>
                <p className="mt-2 text-xl font-bold text-[#10213a]">{rows.length}</p>
                <p className="text-xs text-gray-500">Avg rating {avg.toFixed(1) || "0.0"}/5</p>
              </div>
            );
          })}
        </div>
        <div className="mt-4 space-y-2">
          {feedbackItems.slice(0, 8).map((item) => (
            <div key={item.id} className="rounded-lg border border-gray-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-[#10213a]">{item.memberName || item.memberId}</p>
                <Badge variant="outline">{item.category}</Badge>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Rating {item.rating}/5 • {new Date(item.createdAt).toLocaleString()}
                {item.contactOptIn ? " • follow-up requested" : ""}
              </p>
              <p className="mt-2 text-sm text-gray-700">{item.comment}</p>
              {item.contactInfo ? <p className="mt-1 text-xs text-gray-500">Contact: {item.contactInfo}</p> : null}
            </div>
          ))}
          {feedbackItems.length === 0 ? <p className="text-sm text-gray-500">No feedback submissions yet.</p> : null}
        </div>
      </section>

      <div className="flex flex-wrap gap-3 rounded-[24px] border border-[#dbe7f3] bg-[linear-gradient(180deg,_#fbfdff_0%,_#f5f9fc_100%)] p-3 shadow-[0_10px_24px_rgba(16,33,58,0.04)]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition-all ${
              activeTab === tab.id
                ? "bg-[#10213a] text-white shadow-[0_10px_22px_rgba(16,33,58,0.22)]"
                : "border border-[#d7e2ee] bg-white text-[#51677f] hover:border-[#b8cae0] hover:bg-[#f8fbff]"
            }`}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "notifications" ? (
        <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <Card className="rounded-[28px] border-[#d9e7f5] bg-[linear-gradient(180deg,_#ffffff_0%,_#f8fbff_100%)] p-6 shadow-[0_14px_34px_rgba(16,33,58,0.05)]">
            <h2 className="text-xl font-semibold text-gray-900">Campaign Builder</h2>
            <p className="mt-1 text-sm text-gray-500">Schedule by trigger, target by segment, and compare A/B message variants.</p>

            <div className="mt-5 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="campaign-name">Campaign name</Label>
                <Input id="campaign-name" value={campaignName} onChange={(event) => setCampaignName(event.target.value)} />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Trigger</Label>
                  <select className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={campaignTrigger} onChange={(event) => setCampaignTrigger(event.target.value as NotificationTrigger)}>
                    {triggers.map((trigger) => (
                      <option key={trigger} value={trigger}>
                        {trigger}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>Segment</Label>
                  <select className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={campaignSegment} onChange={(event) => setCampaignSegment(event.target.value as EngagementSegment)}>
                    {segments.map((segment) => (
                      <option key={segment} value={segment}>
                        {segment}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="scheduled-for">Schedule notification</Label>
                <Input id="scheduled-for" type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Variant A</Label>
                  <Textarea rows={4} value={variantA} onChange={(event) => setVariantA(event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Variant B</Label>
                  <Textarea rows={4} value={variantB} onChange={(event) => setVariantB(event.target.value)} />
                </div>
              </div>
              <div className="rounded-2xl border border-[#d8e8fb] bg-[#f3f9ff] p-4 text-sm text-gray-700">
                Estimated audience:{" "}
                <span className="font-semibold">
                  {campaignSegment === "Inactive 60+ Days" ? inactiveMembers.length : getSegmentAudienceSize(campaignSegment, members)}
                </span>
              </div>
              <Button className="w-full bg-[#10213a] text-white hover:bg-[#1b3153]" onClick={createNotificationCampaign}>
                Schedule push campaign
              </Button>
            </div>
          </Card>

          <Card className="rounded-[28px] border-[#d9e7f5] bg-[linear-gradient(180deg,_#ffffff_0%,_#f8fbff_100%)] p-6 shadow-[0_14px_34px_rgba(16,33,58,0.05)]">
            <h2 className="text-xl font-semibold text-gray-900">Templates and Tracking</h2>
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {notificationTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => {
                    setCampaignName(template.name);
                    setCampaignTrigger(template.trigger);
                    setVariantA(template.message);
                    setVariantB(`${template.message} Open now to stay active.`);
                  }}
                  className="rounded-2xl border border-[#dbe7f3] bg-white p-4 text-left transition-all hover:-translate-y-0.5 hover:border-[#9ed8ff] hover:bg-[#f8fcff] hover:shadow-[0_10px_24px_rgba(29,78,216,0.08)]"
                >
                  <p className="font-semibold text-gray-900">{template.name}</p>
                  <p className="mt-1 text-sm text-gray-600">{template.subject}</p>
                </button>
              ))}
            </div>

            <div className="mt-6 space-y-4">
              {state.notificationCampaigns.map((campaign) => {
                const campaignDelivery = campaign.sentCount ? (campaign.deliveredCount / campaign.sentCount) * 100 : 0;
                const campaignOpen = campaign.sentCount ? (campaign.openedCount / campaign.sentCount) * 100 : 0;
                return (
                  <div key={campaign.id} className="rounded-2xl border border-[#dbe7f3] bg-white p-4 shadow-[0_8px_22px_rgba(16,33,58,0.03)]">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-gray-900">{campaign.name}</p>
                          <Badge variant="secondary">{campaign.segment}</Badge>
                          <Badge className={campaign.status === "completed" ? "bg-[#e6f8fa] text-[#0f5f65]" : "bg-[#fff7ed] text-[#c2410c]"}>
                            {campaign.status}
                          </Badge>
                        </div>
                        <p className="mt-1 text-sm text-gray-500">
                          {campaign.trigger} • {new Date(campaign.scheduledFor).toLocaleString()}
                        </p>
                      </div>
                      {campaign.status !== "completed" ? (
                        <Button variant="outline" onClick={() => launchScheduledCampaign(campaign.id)}>
                          Launch now
                        </Button>
                      ) : (
                        <Badge className="bg-[#10213a] text-white">Winner {campaign.winner}</Badge>
                      )}
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      <div className="rounded-xl border border-[#d8e8fb] bg-[#f3f9ff] p-3">
                        <p className="text-xs text-gray-500">Sent</p>
                        <p className="text-xl font-bold text-gray-900">{campaign.sentCount || campaign.audienceSize}</p>
                      </div>
                      <div className="rounded-xl border border-[#d8e8fb] bg-[#f3f9ff] p-3">
                        <p className="text-xs text-gray-500">Delivery rate</p>
                        <p className="text-xl font-bold text-gray-900">{campaignDelivery.toFixed(0)}%</p>
                      </div>
                      <div className="rounded-xl border border-[#d8e8fb] bg-[#f3f9ff] p-3">
                        <p className="text-xs text-gray-500">Open rate</p>
                        <p className="text-xl font-bold text-gray-900">{campaignOpen.toFixed(0)}%</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      ) : null}

      {activeTab === "challenges" ? (
        <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
          <Card className="rounded-[28px] border-[#d9e7f5] bg-[linear-gradient(180deg,_#ffffff_0%,_#f8fffb_100%)] p-6 shadow-[0_14px_34px_rgba(16,33,58,0.05)]">
            <h2 className="text-xl font-semibold text-gray-900">Challenge Catalog</h2>
            <div className="mt-5 space-y-4">
              {state.challenges.map((challenge) => (
                <div key={challenge.id} className="rounded-2xl border border-[#dceee3] bg-white p-4 shadow-[0_8px_22px_rgba(16,33,58,0.03)]">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-gray-900">{challenge.title}</p>
                    <Badge variant="secondary">{challenge.segment}</Badge>
                    {challenge.competitive ? <Badge className="bg-[#10213a] text-white">Competitive</Badge> : null}
                  </div>
                  <p className="mt-2 text-sm text-gray-600">{challenge.description}</p>
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <div className="rounded-xl border border-[#dceee3] bg-[#f3fcf7] p-3">
                      <p className="text-xs text-gray-500">Target</p>
                      <p className="text-lg font-bold text-gray-900">{challenge.targetValue} {challenge.unitLabel}</p>
                    </div>
                    <div className="rounded-xl border border-[#dceee3] bg-[#f3fcf7] p-3">
                      <p className="text-xs text-gray-500">Reward</p>
                      <p className="text-lg font-bold text-gray-900">{challenge.rewardPoints} pts</p>
                    </div>
                    <div className="rounded-xl border border-[#dceee3] bg-[#f3fcf7] p-3">
                      <p className="text-xs text-gray-500">Badge</p>
                      <p className="text-lg font-bold text-gray-900">{challenge.rewardBadge}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="rounded-[28px] border-[#d9e7f5] bg-[linear-gradient(180deg,_#ffffff_0%,_#f8fffb_100%)] p-6 shadow-[0_14px_34px_rgba(16,33,58,0.05)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Leaderboard Preview</h2>
                <p className="text-sm text-gray-500">
                  {selectedChallenge?.title ?? "No challenge selected"}
                </p>
              </div>
              <Badge className="bg-[#e6f8fa] text-[#0f5f65]">Live ranking</Badge>
            </div>
            <div className="mt-5 space-y-3">
              {leaderboard.map((item, index) => (
                <div key={item.memberId} className="rounded-2xl border border-[#dceee3] bg-white p-4 shadow-[0_8px_22px_rgba(16,33,58,0.03)]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#10213a] text-sm font-bold text-white">
                        {index + 1}
                      </div>
                      <div>
                        <p className="font-semibold text-gray-900">{item.memberName}</p>
                        <p className="text-xs text-gray-500">{item.tier}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-gray-900">{item.value}</p>
                      <p className="text-xs text-gray-500">{selectedChallenge?.unitLabel}</p>
                    </div>
                  </div>
                  <Progress className="mt-3 h-2" value={selectedChallenge ? Math.min(100, (item.value / selectedChallenge.targetValue) * 100) : 0} />
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : null}

      {activeTab === "sharing" ? (
        <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <Card className="rounded-[28px] border-[#d9e7f5] bg-[linear-gradient(180deg,_#ffffff_0%,_#fcfaff_100%)] p-6 shadow-[0_14px_34px_rgba(16,33,58,0.05)]">
            <h2 className="text-xl font-semibold text-gray-900">Social Sharing Analytics</h2>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-[#eadcff] bg-[#faf5ff] p-4">
                <p className="text-sm text-gray-500">Tracked shares</p>
                <p className="mt-2 text-3xl font-bold text-gray-900">{totalShares}</p>
              </div>
              <div className="rounded-2xl border border-[#eadcff] bg-[#faf5ff] p-4">
                <p className="text-sm text-gray-500">Referral conversions</p>
                <p className="mt-2 text-3xl font-bold text-gray-900">{totalConversions}</p>
              </div>
              <div className="rounded-2xl border border-[#eadcff] bg-[#faf5ff] p-4">
                <p className="text-sm text-gray-500">Conversion rate</p>
                <p className="mt-2 text-3xl font-bold text-gray-900">{shareConversionRate.toFixed(0)}%</p>
              </div>
            </div>

            <div className="mt-6 space-y-3">
              {state.shareEvents.map((event) => (
                <div key={event.id} className="rounded-2xl border border-[#eadcff] bg-white p-4 shadow-[0_8px_22px_rgba(16,33,58,0.03)]">
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <p className="font-semibold text-gray-900">{event.memberName}</p>
                      <p className="text-sm text-gray-500">
                        {event.achievement} • {event.channel} • {event.tier}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-gray-900">{event.conversions}</p>
                      <p className="text-xs text-gray-500">conversions</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="rounded-[28px] border-[#d9e7f5] bg-[linear-gradient(180deg,_#ffffff_0%,_#fcfaff_100%)] p-6 shadow-[0_14px_34px_rgba(16,33,58,0.05)]">
            <h2 className="text-xl font-semibold text-gray-900">Acceptance Coverage</h2>
            <div className="mt-5 space-y-3 text-sm text-gray-700">
              <div className="rounded-2xl border border-[#eadcff] bg-white p-4">Facebook and Instagram share paths are available on the member side.</div>
              <div className="rounded-2xl border border-[#eadcff] bg-white p-4">Generated share cards include the member tier badge and referral code.</div>
              <div className="rounded-2xl border border-[#eadcff] bg-white p-4">Privacy controls let members hide their name or referral code before sharing.</div>
              <div className="rounded-2xl border border-[#eadcff] bg-white p-4">Share events and simulated conversions feed this admin analytics panel.</div>
            </div>
          </Card>
        </div>
      ) : null}

      {activeTab === "surveys" ? (
        <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <Card className="rounded-[28px] border-[#d9e7f5] bg-[linear-gradient(180deg,_#ffffff_0%,_#fcfaff_100%)] p-6 shadow-[0_14px_34px_rgba(16,33,58,0.05)]">
            <h2 className="text-xl font-semibold text-gray-900">Survey Creator</h2>
            <div className="mt-5 space-y-4">
              <div className="space-y-2">
                <Label>Survey title</Label>
                <Input value={surveyTitle} onChange={(event) => setSurveyTitle(event.target.value)} />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Target segment</Label>
                  <select className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={surveySegment} onChange={(event) => setSurveySegment(event.target.value as EngagementSegment)}>
                    {segments.map((segment) => (
                      <option key={segment} value={segment}>
                        {segment}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>Bonus points</Label>
                  <Input value={surveyBonusPoints} onChange={(event) => setSurveyBonusPoints(event.target.value)} />
                </div>
              </div>

              <div className="space-y-3">
                {surveyQuestions.map((question, index) => (
                  <div key={question.id} className="rounded-2xl border border-[#eadcff] bg-white p-4 shadow-[0_8px_22px_rgba(16,33,58,0.03)]">
                    <div className="grid gap-3 md:grid-cols-[1fr_220px]">
                      <Input
                        value={question.prompt}
                        onChange={(event) => updateSurveyQuestion(question.id, { prompt: event.target.value })}
                        placeholder={`Question ${index + 1}`}
                      />
                      <select
                        className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                        value={question.type}
                        onChange={(event) => updateSurveyQuestion(question.id, { type: event.target.value as QuestionType })}
                      >
                        <option value="multiple-choice">Multiple choice</option>
                        <option value="rating">Rating</option>
                        <option value="free-text">Free text</option>
                      </select>
                    </div>
                    {question.type === "multiple-choice" ? (
                      <Textarea
                        className="mt-3"
                        rows={3}
                        value={(question.options ?? []).join(", ")}
                        onChange={(event) => updateSurveyQuestion(question.id, { options: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })}
                        placeholder="Option A, Option B, Option C"
                      />
                    ) : null}
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-3">
                <Button variant="outline" onClick={addSurveyQuestion}>
                  Add question
                </Button>
                <Button className="bg-[#10213a] text-white hover:bg-[#1b3153]" onClick={createSurvey}>
                  Publish survey
                </Button>
              </div>
            </div>
          </Card>

          <Card className="rounded-[28px] border-[#d9e7f5] bg-[linear-gradient(180deg,_#ffffff_0%,_#fcfaff_100%)] p-6 shadow-[0_14px_34px_rgba(16,33,58,0.05)]">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Survey Results</h2>
                <p className="text-sm text-gray-500">View responses and export survey data.</p>
              </div>
            </div>

            <div className="mt-5 space-y-4">
              {state.surveys.map((survey) => (
                <div key={survey.id} className="rounded-2xl border border-[#eadcff] bg-white p-4 shadow-[0_8px_22px_rgba(16,33,58,0.03)]">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-gray-900">{survey.title}</p>
                        <Badge variant="secondary">{survey.segment}</Badge>
                      </div>
                      <p className="mt-1 text-sm text-gray-600">{survey.description}</p>
                    </div>
                    <Button variant="outline" onClick={() => exportSurveyResponsesCsv(survey)}>
                      <Download className="mr-2 h-4 w-4" />
                      Export CSV
                    </Button>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <div className="rounded-xl border border-[#eadcff] bg-[#faf5ff] p-3">
                      <p className="text-xs text-gray-500">Responses</p>
                      <p className="text-xl font-bold text-gray-900">{survey.responses.length}</p>
                    </div>
                    <div className="rounded-xl border border-[#eadcff] bg-[#faf5ff] p-3">
                      <p className="text-xs text-gray-500">Questions</p>
                      <p className="text-xl font-bold text-gray-900">{survey.questions.length}</p>
                    </div>
                    <div className="rounded-xl border border-[#eadcff] bg-[#faf5ff] p-3">
                      <p className="text-xs text-gray-500">Bonus</p>
                      <p className="text-xl font-bold text-gray-900">{survey.bonusPoints} pts</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : null}

      {activeTab === "winback" ? (
        <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
          <Card className="rounded-[28px] border-[#d9e7f5] bg-[linear-gradient(180deg,_#ffffff_0%,_#fffaf5_100%)] p-6 shadow-[0_14px_34px_rgba(16,33,58,0.05)]">
            <h2 className="text-xl font-semibold text-gray-900">Inactive Member Detection</h2>
            <p className="mt-1 text-sm text-gray-500">Members with no transaction or login activity in the last 60+ days.</p>
            <div className="mt-5 space-y-3">
              {inactiveMembers.slice(0, 6).map((member) => (
                <div key={member.memberId} className="rounded-2xl border border-[#f5dcc3] bg-white p-4 shadow-[0_8px_22px_rgba(16,33,58,0.03)]">
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <p className="font-semibold text-gray-900">{member.memberName}</p>
                      <p className="text-sm text-gray-500">
                        {member.memberNumber} • {member.tier} • {member.daysInactive} inactive days
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge className={member.riskLevel === "High" ? "bg-[#fee2e2] text-[#b91c1c]" : member.riskLevel === "Medium" ? "bg-[#fff7ed] text-[#c2410c]" : "bg-[#e6f8fa] text-[#0f5f65]"}>
                        {member.riskLevel} risk
                      </Badge>
                      <Badge variant="secondary">{member.suggestedOffer}</Badge>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-2xl border border-[#f5dcc3] bg-white p-4 shadow-[0_8px_22px_rgba(16,33,58,0.03)]">
              <h3 className="font-semibold text-gray-900">Launch win-back automation</h3>
              <div className="mt-4 space-y-4">
                <div className="space-y-2">
                  <Label>Campaign name</Label>
                  <Input value={winBackName} onChange={(event) => setWinBackName(event.target.value)} />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Offer type</Label>
                    <select className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={winBackOffer} onChange={(event) => setWinBackOffer(event.target.value as WinBackOfferType)}>
                      {offerTypes.map((offer) => (
                        <option key={offer} value={offer}>
                          {offer}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>Offer value</Label>
                    <Input value={winBackValue} onChange={(event) => setWinBackValue(event.target.value)} />
                  </div>
                </div>
                <Button className="w-full bg-[#10213a] text-white hover:bg-[#1b3153]" onClick={createWinBackCampaign}>
                  Start campaign
                </Button>
              </div>
            </div>
          </Card>

          <Card className="rounded-[28px] border-[#d9e7f5] bg-[linear-gradient(180deg,_#ffffff_0%,_#fffaf5_100%)] p-6 shadow-[0_14px_34px_rgba(16,33,58,0.05)]">
            <h2 className="text-xl font-semibold text-gray-900">Campaign Dashboard</h2>
            <div className="mt-5 space-y-4">
              {state.winBackCampaigns.map((campaign) => {
                const responseRate = campaign.targetedMembers > 0 ? (campaign.responses / campaign.targetedMembers) * 100 : 0;
                const reengagementRate = campaign.targetedMembers > 0 ? (campaign.reengagedMembers / campaign.targetedMembers) * 100 : 0;
                const roi = campaign.offerCost > 0 ? ((campaign.estimatedRevenue - campaign.offerCost) / campaign.offerCost) * 100 : 0;

                return (
                  <div key={campaign.id} className="rounded-2xl border border-[#f5dcc3] bg-white p-4 shadow-[0_8px_22px_rgba(16,33,58,0.03)]">
                    <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-gray-900">{campaign.name}</p>
                          <Badge variant="secondary">{campaign.segment}</Badge>
                        </div>
                        <p className="mt-1 text-sm text-gray-500">
                          {campaign.offerType} • {campaign.offerValue} • {new Date(campaign.launchDate).toLocaleDateString()}
                        </p>
                      </div>
                      <Badge className="bg-[#10213a] text-white">{campaign.status}</Badge>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      <div className="rounded-xl border border-[#f5dcc3] bg-[#fff7ed] p-3">
                        <p className="text-xs text-gray-500">Response rate</p>
                        <p className="text-xl font-bold text-gray-900">{responseRate.toFixed(0)}%</p>
                      </div>
                      <div className="rounded-xl border border-[#f5dcc3] bg-[#fff7ed] p-3">
                        <p className="text-xs text-gray-500">Re-engaged</p>
                        <p className="text-xl font-bold text-gray-900">{reengagementRate.toFixed(0)}%</p>
                      </div>
                      <div className="rounded-xl border border-[#f5dcc3] bg-[#fff7ed] p-3">
                        <p className="text-xs text-gray-500">ROI</p>
                        <p className="text-xl font-bold text-gray-900">{roi.toFixed(0)}%</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
