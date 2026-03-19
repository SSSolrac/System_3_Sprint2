import { useMemo, useState } from "react";
import { useAdminData } from "../hooks/use-admin-data";
import { MemberLookup } from "../../components/member-lookup";
import { awardMemberPoints } from "../../lib/loyalty-supabase";
import { toast } from "sonner";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  buildSegmentStats,
  exportMembersCsv,
  saveManualSegment,
  type MemberSegment,
} from "../../lib/member-lifecycle";

const baseSegments: Array<MemberSegment | "Manual"> = ["High Value", "Active", "At Risk", "Inactive", "Manual"];

export default function AdminMembersPage() {
  const { members, loading, error, refetch } = useAdminData();
  const [query, setQuery] = useState("");
  const [awardingMember, setAwardingMember] = useState<string | null>(null);
  const [selectedMember, setSelectedMember] = useState<(typeof members)[number] | null>(null);
  const [manualAwardMember, setManualAwardMember] = useState<(typeof members)[number] | null>(null);
  const [awardPoints, setAwardPoints] = useState("");
  const [awardReason, setAwardReason] = useState("");
  const [manualSegmentDraft, setManualSegmentDraft] = useState<Record<string, string>>({});
  const [segmentFilter, setSegmentFilter] = useState<string>("All");

  const closeManualAwardDialog = () => {
    setManualAwardMember(null);
    setAwardPoints("");
    setAwardReason("");
  };

  const handleManualAward = async () => {
    if (!manualAwardMember?.member_number) return;

    const points = Number(awardPoints);
    if (!Number.isFinite(points) || points <= 0) {
      toast.error("Please enter a valid positive number of points.");
      return;
    }

    const reason = awardReason.trim();
    if (!reason) {
      toast.error("Reason is required to award points.");
      return;
    }

    try {
      setAwardingMember(manualAwardMember.member_number);
      await awardMemberPoints({
        memberIdentifier: manualAwardMember.member_number,
        points,
        transactionType: "MANUAL_AWARD",
        reason,
      });
      await refetch();
      closeManualAwardDialog();
      toast.success(`Awarded ${points} points to ${manualAwardMember.member_number}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to award points.");
    } finally {
      setAwardingMember(null);
    }
  };

  const segmentedMembers = useMemo(() => {
    const byMember = members.map((member) => {
      const effectiveSegment = member.effective_segment || member.auto_segment || "Inactive";
      return {
        ...member,
        segment: effectiveSegment,
        isManual: Boolean(member.manual_segment),
      };
    });

    return byMember;
  }, [members, manualSegmentDraft]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return segmentedMembers.filter((m) => {
      const fullName = `${m.first_name} ${m.last_name}`.toLowerCase();
      const memberNumber = String(m.member_number || "").toLowerCase();
      const phone = String(m.phone || "").toLowerCase();
      const email = String(m.email || "").toLowerCase();
      const matchesSearch = !q || memberNumber.includes(q) || phone.includes(q) || email.includes(q) || fullName.includes(q);
      const matchesSegment =
        segmentFilter === "All" ? true : segmentFilter === "Manual" ? m.isManual : m.segment === segmentFilter;
      return matchesSearch && matchesSegment;
    });
  }, [segmentedMembers, query, segmentFilter]);

  const stats = useMemo(() => buildSegmentStats(segmentedMembers.length, segmentedMembers.map((m) => m.segment)), [segmentedMembers]);

  const handleManualSegmentSave = async (memberNumber: string, memberId: string, value: string) => {
    try {
      const saved = await saveManualSegment(memberNumber, value);
      setManualSegmentDraft((prev) => ({ ...prev, [memberId]: saved }));
      await refetch();
      toast.success("Manual segment saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save manual segment.");
    }
  };

  const handleExport = () => {
    exportMembersCsv(
      filtered.map((m) => ({
        memberNumber: m.member_number,
        name: `${m.first_name} ${m.last_name}`,
        email: m.email,
        phone: m.phone || "",
        segment: m.segment,
      }))
    );
    toast.success("Segment list exported.");
  };

  if (loading) return <p className="text-base text-gray-700">Loading members...</p>;
  if (error) return <p className="text-red-600">{error}</p>;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Member Segmentation & Lookup</h1>
        <p className="text-gray-500 mt-1">Auto-segment members, manage manual segments, and export target lists.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {stats.map((item) => (
          <div key={item.segment} className="rounded-xl border border-[#9ed8ff] bg-[#f8fcff] p-4">
            <p className="text-xs uppercase tracking-wide text-[#1A2B47]">{item.segment}</p>
            <p className="mt-2 text-2xl font-bold text-[#10213a]">{item.count}</p>
            <p className="text-xs text-gray-600">{item.share.toFixed(1)}% of members</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <MemberLookup onSearch={setQuery} isLoading={loading} />
        <div>
          <Label htmlFor="segment-filter">Filter by segment</Label>
          <select
            id="segment-filter"
            className="mt-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
            value={segmentFilter}
            onChange={(e) => setSegmentFilter(e.target.value)}
          >
            <option value="All">All segments</option>
            {baseSegments.map((segment) => (
              <option key={segment} value={segment}>{segment}</option>
            ))}
          </select>
        </div>
        <Button onClick={handleExport} className="bg-[#1A2B47] text-white hover:bg-[#152238]">Export Segment List</Button>
      </div>

      {selectedMember ? (
        <div className="bg-[#f8fcff] rounded-xl p-5 border border-[#9ed8ff]">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Member Profile</h2>
            <button type="button" onClick={() => setSelectedMember(null)} className="text-sm text-[#1A2B47]">Close</button>
          </div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <p><span className="font-semibold">Member ID:</span> {selectedMember.member_number}</p>
            <p><span className="font-semibold">Name:</span> {selectedMember.first_name} {selectedMember.last_name}</p>
            <p><span className="font-semibold">Mobile:</span> {selectedMember.phone || "-"}</p>
            <p><span className="font-semibold">Email:</span> {selectedMember.email || "-"}</p>
            <p><span className="font-semibold">Points:</span> {(selectedMember.points_balance || 0).toLocaleString()}</p>
            <p><span className="font-semibold">Tier:</span> {selectedMember.tier || "Bronze"}</p>
          </div>
        </div>
      ) : null}

      <Dialog open={Boolean(manualAwardMember)} onOpenChange={(open) => {
        if (!open) closeManualAwardDialog();
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Manual Award</DialogTitle>
            <DialogDescription>
              Award points to {manualAwardMember?.first_name} {manualAwardMember?.last_name} ({manualAwardMember?.member_number}).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="award-points">Points to Award</Label>
              <Input id="award-points" type="number" min="1" step="1" value={awardPoints} onChange={(e) => setAwardPoints(e.target.value)} placeholder="Enter points" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="award-reason">Reason</Label>
              <Input id="award-reason" value={awardReason} onChange={(e) => setAwardReason(e.target.value)} placeholder="Enter reason for manual award" />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeManualAwardDialog}>Cancel</Button>
            <Button onClick={handleManualAward} disabled={awardingMember === manualAwardMember?.member_number}>
              {awardingMember === manualAwardMember?.member_number ? "Awarding..." : "Confirm Award"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="bg-white rounded-xl p-6 border border-[#9ed8ff]">
        <h2 className="text-xl font-semibold text-gray-900 mb-6">Members</h2>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-gray-200">
                <th className="text-left py-3 px-4 text-sm font-semibold text-gray-600">Member #</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-gray-600">Name</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-gray-600">Email</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-gray-600">Mobile</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-gray-600">Points</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-gray-600">Segment</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-gray-600">Manual Segment</th>
                <th className="text-left py-3 px-4 text-sm font-semibold text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((member) => {
                const key = String(member.member_id || member.id || member.member_number);
                return (
                  <tr key={key} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="py-4 px-4 text-sm font-medium text-gray-800">{member.member_number}</td>
                    <td className="py-4 px-4 text-sm text-gray-700">{member.first_name} {member.last_name}</td>
                    <td className="py-4 px-4 text-sm text-gray-600">{member.email}</td>
                    <td className="py-4 px-4 text-sm text-gray-600">{member.phone || "-"}</td>
                    <td className="py-4 px-4 text-sm font-semibold text-gray-800">{(member.points_balance || 0).toLocaleString()}</td>
                    <td className="py-4 px-4 text-sm text-gray-700">{member.segment}{member.isManual ? " (manual)" : ""}</td>
                    <td className="py-4 px-4 text-sm text-gray-600">
                      <div className="flex items-center gap-2">
                        <Input
                          value={manualSegmentDraft[key] || member.manual_segment || ""}
                          onChange={(e) => setManualSegmentDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                          placeholder="High Value | Active | At Risk | Inactive"
                          className="h-8 text-xs"
                        />
                        <Button
                          variant="outline"
                          className="h-8 text-xs"
                          onClick={() => handleManualSegmentSave(member.member_number, key, manualSegmentDraft[key] || member.manual_segment || "")}
                        >
                          Save
                        </Button>
                      </div>
                    </td>
                    <td className="py-4 px-4">
                      <div className="flex gap-2">
                        <button type="button" onClick={() => setSelectedMember(member)} className="rounded-md border border-[#1A2B47] px-3 py-1.5 text-xs font-semibold text-[#1A2B47] hover:bg-[#f5f7fb]">View</button>
                        <button
                          type="button"
                          onClick={() => {
                            setManualAwardMember(member);
                            setAwardPoints("");
                            setAwardReason("");
                          }}
                          disabled={awardingMember === member.member_number}
                          className="rounded-md bg-[#00A3AD] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#08939c] disabled:opacity-60"
                        >
                          {awardingMember === member.member_number ? "Awarding..." : "Award"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 ? <p className="py-6 text-gray-500">No matching members found.</p> : null}
        </div>
      </div>
    </div>
  );
}
