import { useEffect, useMemo, useState } from "react";
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
  createCustomSegment,
  deleteCustomSegment,
  exportMembersCsv,
  fetchAllSegments,
  fetchSegmentAssignments,
  removeMembersFromSegment,
  saveManualSegment,
  SYSTEM_MEMBER_SEGMENTS,
  updateCustomSegment,
  assignMembersToSegment,
} from "../../lib/member-lifecycle";

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
  const [segments, setSegments] = useState<Array<{ id: string; name: string; description: string | null; is_system: boolean }>>([]);
  const [memberSegmentMap, setMemberSegmentMap] = useState<Record<string, string[]>>({});
  const [selectedMemberKeys, setSelectedMemberKeys] = useState<Record<string, boolean>>({});
  const [segmentName, setSegmentName] = useState("");
  const [segmentDescription, setSegmentDescription] = useState("");
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [segmentDialogOpen, setSegmentDialogOpen] = useState(false);
  const [bulkSegmentId, setBulkSegmentId] = useState<string>("");

  const loadManualSegments = async () => {
    const [allSegments, assignments] = await Promise.all([fetchAllSegments(), fetchSegmentAssignments()]);
    setSegments(allSegments);
    const nextMap: Record<string, string[]> = {};
    for (const row of assignments as Array<{ member_id?: string | number; member_segments?: { name?: string } }>) {
      const key = String(row.member_id ?? "");
      const segmentNameValue = row.member_segments?.name;
      if (!key || !segmentNameValue) continue;
      nextMap[key] = nextMap[key] ? [...nextMap[key], segmentNameValue] : [segmentNameValue];
    }
    setMemberSegmentMap(nextMap);
  };

  useEffect(() => {
    loadManualSegments().catch((err) => {
      console.error(err);
      toast.error("Unable to load member segments.");
    });
  }, []);

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
      const memberKey = String(member.id ?? member.member_id ?? "");
      const assignedSegments = memberSegmentMap[memberKey] || [];
      const customSegments = assignedSegments.filter((name) => !SYSTEM_MEMBER_SEGMENTS.includes(name as (typeof SYSTEM_MEMBER_SEGMENTS)[number]));
      return {
        ...member,
        segment: effectiveSegment,
        isManual: Boolean(member.manual_segment),
        customSegments,
        allSegments: Array.from(new Set([effectiveSegment, ...customSegments])),
      };
    });

    return byMember;
  }, [members, memberSegmentMap]);

  const segmentFilterOptions = useMemo(() => {
    const custom = segments.filter((segment) => !segment.is_system).map((segment) => segment.name);
    return ["Manual", ...SYSTEM_MEMBER_SEGMENTS, ...custom];
  }, [segments]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return segmentedMembers.filter((m) => {
      const fullName = `${m.first_name} ${m.last_name}`.toLowerCase();
      const memberNumber = String(m.member_number || "").toLowerCase();
      const phone = String(m.phone || "").toLowerCase();
      const email = String(m.email || "").toLowerCase();
      const matchesSearch = !q || memberNumber.includes(q) || phone.includes(q) || email.includes(q) || fullName.includes(q);
      const matchesSegment =
        segmentFilter === "All"
          ? true
          : segmentFilter === "Manual"
          ? m.isManual || m.customSegments.length > 0
          : m.segment === segmentFilter || m.customSegments.includes(segmentFilter);
      return matchesSearch && matchesSegment;
    });
  }, [segmentedMembers, query, segmentFilter]);

  const stats = useMemo(
    () => buildSegmentStats(segmentedMembers.length, segmentedMembers.flatMap((m) => (m.customSegments.length ? m.allSegments : [m.segment]))),
    [segmentedMembers]
  );

  const handleManualSegmentSave = async (memberNumber: string, memberId: string, value: string) => {
    try {
      const saved = await saveManualSegment(memberNumber, value);
      await refetch();
      await loadManualSegments();
      setManualSegmentDraft((prev) => ({ ...prev, [memberId]: saved }));
      toast.success("Manual segment saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save manual segment.");
    }
  };

  const selectedMemberIds = useMemo(
    () =>
      filtered
        .filter((member) => selectedMemberKeys[String(member.member_id ?? member.id ?? member.member_number)])
        .map((member) => member.member_id ?? member.id),
    [filtered, selectedMemberKeys]
  );

  const handleCreateOrUpdateSegment = async () => {
    try {
      if (editingSegmentId) {
        await updateCustomSegment(editingSegmentId, { name: segmentName, description: segmentDescription });
        toast.success("Segment updated.");
      } else {
        await createCustomSegment({ name: segmentName, description: segmentDescription });
        toast.success("Segment created.");
      }
      setSegmentDialogOpen(false);
      setSegmentName("");
      setSegmentDescription("");
      setEditingSegmentId(null);
      await loadManualSegments();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to save segment.");
    }
  };

  const handleDeleteSegment = async (segmentId: string) => {
    try {
      await deleteCustomSegment(segmentId);
      toast.success("Segment deleted.");
      await loadManualSegments();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to delete segment.");
    }
  };

  const handleBulkAssign = async () => {
    if (!bulkSegmentId) return toast.error("Select a segment.");
    if (!selectedMemberIds.length) return toast.error("Select at least one member.");
    try {
      await assignMembersToSegment(selectedMemberIds, bulkSegmentId);
      toast.success("Members assigned to segment.");
      setSelectedMemberKeys({});
      await loadManualSegments();
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to assign members.");
    }
  };

  const handleRemoveFromSegment = async (memberId: string | number, segmentNameValue: string) => {
    try {
      const segment = segments.find((entry) => entry.name === segmentNameValue);
      if (!segment) return;
      await removeMembersFromSegment([memberId], segment.id);
      toast.success(`Removed from ${segmentNameValue}.`);
      await loadManualSegments();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to remove member from segment.");
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
            {segmentFilterOptions.map((segment) => (
              <option key={segment} value={segment}>{segment}</option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setEditingSegmentId(null);
            setSegmentName("");
            setSegmentDescription("");
            setSegmentDialogOpen(true);
          }}
        >
          Create Segment
        </Button>
        <Button onClick={handleExport} className="bg-[#1A2B47] text-white hover:bg-[#152238]">Export Segment List</Button>
      </div>

      <Dialog open={segmentDialogOpen} onOpenChange={setSegmentDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingSegmentId ? "Edit Custom Segment" : "Create Custom Segment"}</DialogTitle>
            <DialogDescription>Define a custom member segment for manual assignment.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="segment-name">Segment name</Label>
              <Input id="segment-name" value={segmentName} onChange={(e) => setSegmentName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="segment-description">Description</Label>
              <Input id="segment-description" value={segmentDescription} onChange={(e) => setSegmentDescription(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSegmentDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateOrUpdateSegment}>{editingSegmentId ? "Save Changes" : "Create Segment"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="bg-white rounded-xl p-6 border border-[#9ed8ff] space-y-3">
        <h2 className="text-lg font-semibold text-gray-900">Custom Segments</h2>
        <div className="grid grid-cols-1 gap-2">
          {segments.filter((segment) => !segment.is_system).map((segment) => (
            <div key={segment.id} className="rounded-md border border-gray-200 p-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-gray-900">{segment.name}</p>
                <p className="text-xs text-gray-500">{segment.description || "No description"}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingSegmentId(segment.id);
                    setSegmentName(segment.name);
                    setSegmentDescription(segment.description || "");
                    setSegmentDialogOpen(true);
                  }}
                >
                  Edit
                </Button>
                <Button variant="outline" size="sm" onClick={() => handleDeleteSegment(segment.id)}>Delete</Button>
              </div>
            </div>
          ))}
          {segments.filter((segment) => !segment.is_system).length === 0 ? <p className="text-sm text-gray-500">No custom segments yet.</p> : null}
        </div>
      </div>

      <div className="bg-white rounded-xl p-4 border border-[#9ed8ff] flex flex-wrap gap-3 items-end">
        <div>
          <Label htmlFor="bulk-segment">Assign selected to segment</Label>
          <select id="bulk-segment" className="mt-1 rounded-md border border-gray-300 px-3 py-2 text-sm" value={bulkSegmentId} onChange={(e) => setBulkSegmentId(e.target.value)}>
            <option value="">Select segment</option>
            {segments.map((segment) => (
              <option key={segment.id} value={segment.id}>{segment.name}</option>
            ))}
          </select>
        </div>
        <Button onClick={handleBulkAssign}>Assign Members</Button>
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
                <th className="text-left py-3 px-4 text-sm font-semibold text-gray-600">Select</th>
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
                    <td className="py-4 px-4 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={Boolean(selectedMemberKeys[String(member.member_id ?? member.id ?? member.member_number)])}
                        onChange={(e) =>
                          setSelectedMemberKeys((prev) => ({
                            ...prev,
                            [String(member.member_id ?? member.id ?? member.member_number)]: e.target.checked,
                          }))
                        }
                      />
                    </td>
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
                      {member.customSegments.length ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {member.customSegments.map((segment) => (
                            <button
                              key={`${key}-${segment}`}
                              type="button"
                              onClick={() => handleRemoveFromSegment(member.member_id ?? member.id ?? member.member_number, segment)}
                              className="rounded-full border border-gray-300 px-2 py-0.5 text-[10px] text-gray-700 hover:bg-gray-100"
                            >
                              {segment} ×
                            </button>
                          ))}
                        </div>
                      ) : null}
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
