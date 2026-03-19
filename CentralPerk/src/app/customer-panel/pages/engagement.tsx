import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Award, Download, Facebook, Instagram, Share2, Trophy } from "lucide-react";
import { toast } from "sonner";
import { Card } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Progress } from "../../components/ui/progress";
import { Textarea } from "../../components/ui/textarea";
import type { AppOutletContext } from "../../types/app-context";
import { awardMemberPoints } from "../../lib/loyalty-supabase";
import {
  claimBirthdayReward,
  createReferral,
  getMemberReferralCode,
  getBirthdayRewardPoints,
  hasBirthdayClaimedThisYear,
  isBirthdayMonth,
  loadBirthdayRewardStatus,
  loadReferrals,
  queueManagerFeedbackNotification,
  submitFeedback,
  type ReferralRecord,
} from "../../lib/member-lifecycle";
import {
  buildShareAssetDataUrl,
  getChallengeProgress,
  getMemberPrivacySettings,
  loadEngagementState,
  saveEngagementState,
  triggerDownload,
  type EngagementState,
  type SharePrivacySettings,
  type SocialChannel,
} from "../../lib/member-engagement";

export default function CustomerEngagementPage() {
  const { user, refreshUser, setUser } = useOutletContext<AppOutletContext>();
  const [state, setState] = useState<EngagementState>(() => loadEngagementState());
  const [selectedAchievement, setSelectedAchievement] = useState("Tier upgrade unlocked");
  const [surveyAnswers, setSurveyAnswers] = useState<Record<string, Record<string, string>>>({});
  const [submittingSurveyId, setSubmittingSurveyId] = useState<string | null>(null);
  const [claimingChallengeId, setClaimingChallengeId] = useState<string | null>(null);
  const [referralEmail, setReferralEmail] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [myReferrals, setMyReferrals] = useState<ReferralRecord[]>([]);
  const [birthdayStatus, setBirthdayStatus] = useState<{ hasReward: boolean; voucherCode: string | null; pointsAwarded: number; badgeLabel: string | null; voucherExpiresAt?: string }>({
    hasReward: false,
    voucherCode: null,
    pointsAwarded: 0,
    badgeLabel: null,
  });
  const [feedbackCategory, setFeedbackCategory] = useState<"points" | "rewards" | "service" | "app">("service");
  const [feedbackRating, setFeedbackRating] = useState<1 | 2 | 3 | 4 | 5>(5);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackContactOptIn, setFeedbackContactOptIn] = useState(false);
  const [feedbackContactInfo, setFeedbackContactInfo] = useState("");

  useEffect(() => {
    saveEngagementState(state);
  }, [state]);

  const privacySettings = useMemo<SharePrivacySettings>(
    () => getMemberPrivacySettings(state, user.memberId),
    [state, user.memberId]
  );
  useEffect(() => {
    getMemberReferralCode(user.memberId, user.email)
      .then(setReferralCode)
      .catch(() => setReferralCode(""));
    loadReferrals(user.memberId)
      .then(setMyReferrals)
      .catch(() => setMyReferrals([]));
    loadBirthdayRewardStatus(user.memberId, user.email)
      .then(setBirthdayStatus)
      .catch(() => setBirthdayStatus({ hasReward: false, voucherCode: null, pointsAwarded: 0, badgeLabel: null }));
  }, [user.memberId, user.email]);
  const sharePreview = useMemo(
    () =>
      buildShareAssetDataUrl({
        memberName: user.fullName,
        tier: user.tier,
        achievement: selectedAchievement,
        referralCode,
        privacy: privacySettings,
      }),
    [privacySettings, referralCode, selectedAchievement, user.fullName, user.tier]
  );

  const claimedChallenges = new Set(state.claimedChallengeRewardsByMember[user.memberId] ?? []);
  const activeSurveys = state.surveys.filter((survey) => survey.status === "live");
  const memberShareEvents = state.shareEvents.filter((item) => item.memberId === user.memberId);

  const updatePrivacy = (patch: Partial<SharePrivacySettings>) => {
    setState((prev) => ({
      ...prev,
      privacySettingsByMember: {
        ...prev.privacySettingsByMember,
        [user.memberId]: {
          ...getMemberPrivacySettings(prev, user.memberId),
          ...patch,
        },
      },
    }));
  };

  const handleShare = (channel: SocialChannel) => {
    const nextEvent = {
      id: crypto.randomUUID(),
      memberId: user.memberId,
      memberName: user.fullName,
      tier: user.tier,
      channel,
      achievement: selectedAchievement,
      referralCode,
      conversions: 0,
      createdAt: new Date().toISOString(),
    };

    setState((prev) => ({
      ...prev,
      shareEvents: [nextEvent, ...prev.shareEvents],
    }));

    if (channel === "facebook") {
      const shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent("https://centralperk.example/member")}&quote=${encodeURIComponent(`${selectedAchievement} | Referral code: ${referralCode}`)}`;
      window.open(shareUrl, "_blank", "noopener,noreferrer");
    } else {
      triggerDownload(sharePreview, `centralperk-${user.memberId}-story-card.svg`);
      toast.success("Instagram share asset downloaded.", {
        description: "Upload the generated image to your story or post.",
      });
    }

    toast.success(`Shared to ${channel === "facebook" ? "Facebook" : "Instagram"}.`);
  };

  const handleMockConversion = (shareId: string) => {
    setState((prev) => ({
      ...prev,
      shareEvents: prev.shareEvents.map((item) =>
        item.id === shareId ? { ...item, conversions: item.conversions + 1 } : item
      ),
    }));
  };

  const handleClaimChallenge = async (challengeId: string, rewardPoints: number, title: string) => {
    try {
      setClaimingChallengeId(challengeId);
      await awardMemberPoints({
        memberIdentifier: user.memberId,
        fallbackEmail: user.email,
        points: rewardPoints,
        transactionType: "MANUAL_AWARD",
        reason: `Challenge reward (${challengeId}): ${title}`,
      });

      setState((prev) => ({
        ...prev,
        claimedChallengeRewardsByMember: {
          ...prev.claimedChallengeRewardsByMember,
          [user.memberId]: [...new Set([...(prev.claimedChallengeRewardsByMember[user.memberId] ?? []), challengeId])],
        },
      }));

      await refreshUser();
      toast.success(`Challenge reward claimed. +${rewardPoints} points`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to claim challenge reward.");
    } finally {
      setClaimingChallengeId(null);
    }
  };



  const handleCreateReferral = () => {
    const email = referralEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      toast.error("Enter a valid friend email.");
      return;
    }

    createReferral({
      referrerMemberId: user.memberId,
      refereeEmail: email,
    })
      .then(() => loadReferrals(user.memberId))
      .then((rows) => {
        setMyReferrals(rows);
        setReferralEmail("");
        toast.success("Referral created. Share your code via SMS, email, or QR flow.");
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : "Failed to create referral."));
  };

  const handleBirthdayClaim = async () => {
    if (!isBirthdayMonth(user)) {
      toast.error("Birthday rewards unlock on your birthday month.");
      return;
    }
    const alreadyClaimed = await hasBirthdayClaimedThisYear(user.memberId, user.email);
    if (alreadyClaimed) {
      toast.error("Birthday reward already claimed this year.");
      return;
    }
    try {
      const result = await claimBirthdayReward(user.memberId, user.email);
      await refreshUser();
      const status = await loadBirthdayRewardStatus(user.memberId, user.email);
      setBirthdayStatus(status);
      toast.success(
        result.granted
          ? `Birthday reward credited: +${result.pointsAwarded || getBirthdayRewardPoints(user.tier)} points.`
          : "Birthday reward is already granted for this year."
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to claim birthday reward.");
    }
  };

  const referralLink = referralCode ? `${window.location.origin}/register?ref=${encodeURIComponent(referralCode)}` : "";

  const handleFeedbackSubmit = async () => {
    const comment = feedbackComment.trim();
    if (!comment) {
      toast.error("Feedback comment is required.");
      return;
    }
    if (comment.length > 500) {
      toast.error("Feedback must be 500 characters or less.");
      return;
    }

    try {
      const saved = await submitFeedback({
        memberId: user.memberId,
        memberName: user.fullName,
        category: feedbackCategory,
        rating: feedbackRating,
        comment,
        contactOptIn: feedbackContactOptIn,
        contactInfo: feedbackContactInfo.trim() || null,
      });
      try {
        await queueManagerFeedbackNotification(saved);
      } catch {
        // Feedback is already saved; notification failure should not block submission.
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to submit feedback.");
      return;
    }

    setFeedbackComment("");
    setFeedbackContactOptIn(false);
    setFeedbackContactInfo("");
    toast.success("Feedback submitted. Thank you!");
  };

  const handleSurveyAnswerChange = (surveyId: string, questionId: string, value: string) => {
    setSurveyAnswers((prev) => ({
      ...prev,
      [surveyId]: {
        ...prev[surveyId],
        [questionId]: value,
      },
    }));
  };

  const handleSubmitSurvey = async (surveyId: string) => {
    const survey = state.surveys.find((item) => item.id === surveyId);
    if (!survey) return;

    const answers = surveyAnswers[surveyId] ?? {};
    const missing = survey.questions.some((question) => !String(answers[question.id] ?? "").trim());
    if (missing) {
      toast.error("Please complete every survey question.");
      return;
    }

    const alreadySubmitted = survey.responses.some((response) => response.memberId === user.memberId);
    if (alreadySubmitted) {
      toast.error("You already completed this survey.");
      return;
    }

    try {
      setSubmittingSurveyId(surveyId);
      await awardMemberPoints({
        memberIdentifier: user.memberId,
        fallbackEmail: user.email,
        points: survey.bonusPoints,
        transactionType: "MANUAL_AWARD",
        reason: `Survey completion (${surveyId}): ${survey.title}`,
      });

      setState((prev) => ({
        ...prev,
        surveys: prev.surveys.map((item) =>
          item.id === surveyId
            ? {
                ...item,
                responses: [
                  ...item.responses,
                  {
                    memberId: user.memberId,
                    memberName: user.fullName,
                    answers,
                    submittedAt: new Date().toISOString(),
                  },
                ],
              }
            : item
        ),
      }));

      setUser((prev) => ({ ...prev, surveysCompleted: prev.surveysCompleted + 1 }));
      await refreshUser();
      toast.success(`Survey submitted. +${survey.bonusPoints} points added.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to submit survey.");
    } finally {
      setSubmittingSurveyId(null);
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Member Engagement</h1>
        <p className="text-gray-500 mt-1">Challenges, social sharing, and surveys.</p>
      </div>

      <Card className="p-6 border-[#9ed8ff] bg-gradient-to-br from-[#10213a] to-[#00a3ad] text-white">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-3xl font-bold">Keep members active, visible, and coming back.</h2>
            <p className="mt-2 max-w-2xl text-sm text-[#ddfbff]">
              Your member hub now includes time-limited challenges, shareable achievement cards, privacy controls,
              and bonus-point surveys.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-2xl bg-white/10 p-4">
              <p className="text-[#b9f6ff]">Surveys done</p>
              <p className="mt-1 text-2xl font-bold">{user.surveysCompleted}</p>
            </div>
            <div className="rounded-2xl bg-white/10 p-4">
              <p className="text-[#b9f6ff]">Shares tracked</p>
              <p className="mt-1 text-2xl font-bold">{memberShareEvents.length}</p>
            </div>
          </div>
        </div>
      </Card>



      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="p-6">
          <h2 className="text-xl font-semibold text-gray-900">Referral Program</h2>
          <p className="text-sm text-gray-500 mt-1">Share your code and earn 500 points when friends join. Friends earn 200 points.</p>
          <p className="mt-3 text-sm">Your referral code: <span className="font-bold text-[#10213a]">{referralCode}</span></p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => window.open(`sms:?body=${encodeURIComponent(`Join Central Perk Rewards with my code ${referralCode}: ${referralLink}`)}`, "_self")}
            >
              Share via SMS
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => window.open(`mailto:?subject=${encodeURIComponent("Join Central Perk Rewards")}&body=${encodeURIComponent(`Use my referral code ${referralCode} and sign up here: ${referralLink}`)}`, "_self")}
            >
              Share via Email
            </Button>
            <Button type="button" variant="outline" onClick={() => navigator.clipboard.writeText(referralLink)}>
              Copy QR Link
            </Button>
          </div>
          {referralLink ? (
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(referralLink)}`}
              alt="Referral QR code"
              className="mt-3 h-24 w-24 rounded border border-gray-200"
            />
          ) : null}
          <div className="mt-3 space-y-2">
            <Label htmlFor="referral-email">Friend email</Label>
            <Input id="referral-email" value={referralEmail} onChange={(e) => setReferralEmail(e.target.value)} placeholder="friend@email.com" />
            <Button onClick={handleCreateReferral} className="bg-[#1A2B47] text-white hover:bg-[#152238]">Create Referral</Button>
          </div>
          <p className="mt-4 text-xs text-gray-500">Tracked referrals: {myReferrals.length} • Conversions: {myReferrals.filter((r) => r.status === "joined").length}</p>
        </Card>

        <Card className="p-6">
          <h2 className="text-xl font-semibold text-gray-900">Birthday Rewards</h2>
          <p className="text-sm text-gray-500 mt-1">Auto-credited on the 1st of your birthday month. Claim once per year.</p>
          <p className="mt-3 text-sm">Current tier bonus: <span className="font-semibold">{getBirthdayRewardPoints(user.tier)} points</span></p>
          <p className="mt-1 text-xs text-gray-500">
            Voucher + birthday badge are included in your month benefits.
            {birthdayStatus.voucherCode ? ` Voucher: ${birthdayStatus.voucherCode}` : ""}
          </p>
          {birthdayStatus.badgeLabel ? <Badge className="mt-2">{birthdayStatus.badgeLabel}</Badge> : null}
          <Button onClick={handleBirthdayClaim} className="mt-3 bg-[#00A3AD] text-white hover:bg-[#08939c]" disabled={!isBirthdayMonth(user) || birthdayStatus.hasReward}>
            {birthdayStatus.hasReward ? "Claimed this year" : "Claim Birthday Reward"}
          </Button>
        </Card>

        <Card className="p-6">
          <h2 className="text-xl font-semibold text-gray-900">Feedback</h2>
          <p className="text-sm text-gray-500 mt-1">Rate your experience and help us improve.</p>
          <div className="mt-3 space-y-2">
            <Label>Category</Label>
            <select className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={feedbackCategory} onChange={(e) => setFeedbackCategory(e.target.value as any)}>
              <option value="points">Points</option><option value="rewards">Rewards</option><option value="service">Service</option><option value="app">App</option>
            </select>
            <Label>Rating (1-5)</Label>
            <Input type="number" min={1} max={5} value={feedbackRating} onChange={(e) => setFeedbackRating(Math.max(1, Math.min(5, Number(e.target.value) || 5)) as 1 | 2 | 3 | 4 | 5)} />
            <Label>Comments</Label>
            <Textarea maxLength={500} value={feedbackComment} onChange={(e) => setFeedbackComment(e.target.value)} placeholder="Share your suggestions (max 500 chars)" />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={feedbackContactOptIn} onChange={(e) => setFeedbackContactOptIn(e.target.checked)} /> Contact me for follow-up</label>
            <Label>Optional contact</Label>
            <Input
              value={feedbackContactInfo}
              onChange={(e) => setFeedbackContactInfo(e.target.value)}
              placeholder="Email or phone for follow-up"
            />
            <Button onClick={handleFeedbackSubmit}>Submit Feedback</Button>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6">
        <Card className="p-6">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-[#e6f8fa] p-3">
              <Trophy className="h-5 w-5 text-[#0f5f65]" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Active Challenges</h2>
              <p className="text-sm text-gray-500">Track progress, unlock badges, and claim bonus points.</p>
            </div>
          </div>

          <div className="mt-5 space-y-4">
            {state.challenges.map((challenge) => {
              const progress = getChallengeProgress(challenge, user);
              const claimed = claimedChallenges.has(challenge.id);
              return (
                <div key={challenge.id} className="rounded-2xl border border-gray-200 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-gray-900">{challenge.title}</h3>
                        <Badge variant="secondary">{challenge.segment}</Badge>
                        {challenge.competitive ? <Badge className="bg-[#10213a] text-white">Leaderboard</Badge> : null}
                      </div>
                      <p className="mt-1 text-sm text-gray-600">{challenge.description}</p>
                      <p className="mt-2 text-xs text-gray-500">
                        Runs until {new Date(challenge.endAt).toLocaleDateString()} • Reward {challenge.rewardPoints} pts • {challenge.rewardBadge}
                      </p>
                    </div>
                    <div className="rounded-xl bg-[#f8fcff] px-4 py-3 text-right">
                      <p className="text-xs text-gray-500">Progress</p>
                      <p className="text-xl font-bold text-[#10213a]">
                        {progress.current}/{progress.target}
                      </p>
                      <p className="text-xs text-gray-500">{challenge.unitLabel}</p>
                    </div>
                  </div>
                  <Progress className="mt-4 h-2" value={progress.percent} />
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-gray-600">
                      {progress.completed ? "Challenge completed. Reward ready to claim." : "Stay active to finish this challenge on time."}
                    </p>
                    <Button
                      disabled={!progress.completed || claimed || claimingChallengeId === challenge.id}
                      className="bg-[#10213a] text-white hover:bg-[#1b3153]"
                      onClick={() => handleClaimChallenge(challenge.id, challenge.rewardPoints, challenge.title)}
                    >
                      {claimed ? "Reward Claimed" : claimingChallengeId === challenge.id ? "Claiming..." : "Claim Reward"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-[#f5f0ff] p-3">
              <Share2 className="h-5 w-5 text-[#6d28d9]" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Social Sharing</h2>
              <p className="text-sm text-gray-500">Share tier moments and badges with referral tracking.</p>
            </div>
          </div>

          <div className="mt-5 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="achievement">Achievement to share</Label>
              <Input id="achievement" value={selectedAchievement} onChange={(event) => setSelectedAchievement(event.target.value)} />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="flex items-center gap-2 rounded-xl border border-gray-200 p-3 text-sm">
                <input type="checkbox" checked={privacySettings.showName} onChange={(event) => updatePrivacy({ showName: event.target.checked })} />
                Show name
              </label>
              <label className="flex items-center gap-2 rounded-xl border border-gray-200 p-3 text-sm">
                <input
                  type="checkbox"
                  checked={privacySettings.showReferralCode}
                  onChange={(event) => updatePrivacy({ showReferralCode: event.target.checked })}
                />
                Show referral code
              </label>
              <label className="flex items-center gap-2 rounded-xl border border-gray-200 p-3 text-sm">
                <input
                  type="checkbox"
                  checked={privacySettings.publicProfile}
                  onChange={(event) => updatePrivacy({ publicProfile: event.target.checked })}
                />
                Public profile
              </label>
            </div>

            <div className="overflow-hidden rounded-3xl border border-gray-200 bg-[#f7fbff]">
              <img src={sharePreview} alt="Share card preview" className="w-full object-cover" />
            </div>

            <div className="flex flex-wrap gap-3">
              <Button className="bg-[#1877f2] text-white hover:bg-[#1669d6]" onClick={() => handleShare("facebook")}>
                <Facebook className="mr-2 h-4 w-4" />
                Share to Facebook
              </Button>
              <Button className="bg-[#d62976] text-white hover:bg-[#c02268]" onClick={() => handleShare("instagram")}>
                <Instagram className="mr-2 h-4 w-4" />
                Share to Instagram
              </Button>
              <Button variant="outline" onClick={() => triggerDownload(sharePreview, `centralperk-${user.memberId}-achievement.svg`)}>
                <Download className="mr-2 h-4 w-4" />
                Download card
              </Button>
            </div>

            <div className="space-y-3">
              {memberShareEvents.slice(0, 3).map((event) => (
                <div key={event.id} className="flex flex-col gap-3 rounded-2xl border border-gray-200 p-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="font-medium text-gray-900">{event.achievement}</p>
                    <p className="text-sm text-gray-500">
                      {event.channel} • {new Date(event.createdAt).toLocaleString()} • {event.conversions} conversion(s)
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => handleMockConversion(event.id)}>
                    Simulate conversion
                  </Button>
                </div>
              ))}
              {memberShareEvents.length === 0 ? <p className="text-sm text-gray-500">Your tracked shares will appear here.</p> : null}
            </div>
          </div>
        </Card>
      </div>

      <Card className="p-6">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-[#fff7ed] p-3">
            <Award className="h-5 w-5 text-[#c2410c]" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Member Surveys</h2>
            <p className="text-sm text-gray-500">Complete surveys, earn bonus points, and help shape future perks.</p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {activeSurveys.map((survey) => {
            const alreadySubmitted = survey.responses.some((response) => response.memberId === user.memberId);
            return (
              <div key={survey.id} className="rounded-2xl border border-gray-200 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-gray-900">{survey.title}</h3>
                    <p className="mt-1 text-sm text-gray-600">{survey.description}</p>
                    <p className="mt-2 text-xs text-gray-500">
                      {survey.questions.length} questions • Segment {survey.segment} • Reward {survey.bonusPoints} points
                    </p>
                  </div>
                  <Badge className="bg-[#fff7ed] text-[#c2410c]">{survey.status}</Badge>
                </div>

                <div className="mt-4 space-y-4">
                  {survey.questions.map((question) => (
                    <div key={question.id} className="space-y-2">
                      <Label>{question.prompt}</Label>
                      {question.type === "rating" ? (
                        <div className="flex gap-2">
                          {[1, 2, 3, 4, 5].map((value) => (
                            <button
                              key={value}
                              type="button"
                              disabled={alreadySubmitted}
                              onClick={() => handleSurveyAnswerChange(survey.id, question.id, String(value))}
                              className={`h-10 w-10 rounded-lg border text-sm font-semibold ${
                                (surveyAnswers[survey.id]?.[question.id] ?? "") === String(value)
                                  ? "border-[#10213a] bg-[#10213a] text-white"
                                  : "border-gray-200 bg-white text-gray-700"
                              }`}
                            >
                              {value}
                            </button>
                          ))}
                        </div>
                      ) : question.type === "multiple-choice" ? (
                        <div className="grid gap-2">
                          {(question.options ?? []).map((option) => (
                            <label key={option} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm">
                              <input
                                type="radio"
                                name={`${survey.id}-${question.id}`}
                                checked={(surveyAnswers[survey.id]?.[question.id] ?? "") === option}
                                onChange={() => handleSurveyAnswerChange(survey.id, question.id, option)}
                                disabled={alreadySubmitted}
                              />
                              {option}
                            </label>
                          ))}
                        </div>
                      ) : (
                        <Textarea
                          rows={4}
                          disabled={alreadySubmitted}
                          value={surveyAnswers[survey.id]?.[question.id] ?? ""}
                          onChange={(event) => handleSurveyAnswerChange(survey.id, question.id, event.target.value)}
                          placeholder="Share your feedback"
                        />
                      )}
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-gray-600">
                    {alreadySubmitted ? "Survey already submitted. Thanks for the feedback." : "Submit once to earn your bonus points."}
                  </p>
                  <Button
                    disabled={alreadySubmitted || submittingSurveyId === survey.id}
                    className="bg-[#10213a] text-white hover:bg-[#1b3153]"
                    onClick={() => handleSubmitSurvey(survey.id)}
                  >
                    {alreadySubmitted ? "Completed" : submittingSurveyId === survey.id ? "Submitting..." : `Submit for ${survey.bonusPoints} pts`}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
