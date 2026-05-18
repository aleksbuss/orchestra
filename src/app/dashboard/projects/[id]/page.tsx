"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2 } from "lucide-react";
import { KnowledgeSection } from "@/components/knowledge-section";
import { ProjectContextSection } from "@/components/project-context-section";
import { CronSection } from "@/components/cron-section";
import type { Project } from "@/lib/types";

export default function ProjectDetailsPage() {
    const params = useParams();
    const router = useRouter();
    const id = params.id as string;
    const [project, setProject] = useState<Project | null>(null);
    const [instructionsDraft, setInstructionsDraft] = useState("");
    const [instructionsSaving, setInstructionsSaving] = useState(false);
    const [instructionsStatus, setInstructionsStatus] = useState<string | null>(null);
    const [instructionsStatusTone, setInstructionsStatusTone] = useState<"success" | "error" | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch(`/api/projects/${id}`)
            .then((res) => {
                if (!res.ok) throw new Error("Project not found");
                return res.json();
            })
            .then((data: Project) => {
                setProject(data);
                setInstructionsDraft(data.instructions || "");
                setLoading(false);
            })
            .catch(() => {
                setProject(null); // Explicitly set null on error
                setLoading(false);
            });
    }, [id]);

    async function handleSaveInstructions() {
        if (!project) return;
        try {
            setInstructionsSaving(true);
            setInstructionsStatus(null);
            setInstructionsStatusTone(null);

            const res = await fetch(`/api/projects/${project.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ instructions: instructionsDraft }),
            });
            const payload = (await res.json()) as Project | { error?: string };
            if (!res.ok) {
                throw new Error(
                    "error" in payload && typeof payload.error === "string"
                        ? payload.error
                        : "Failed to save instructions"
                );
            }

            setProject(payload as Project);
            setInstructionsDraft((payload as Project).instructions || "");
            setInstructionsStatus("Instructions updated.");
            setInstructionsStatusTone("success");
        } catch (error) {
            setInstructionsStatus(
                error instanceof Error ? error.message : "Failed to save instructions"
            );
            setInstructionsStatusTone("error");
        } finally {
            setInstructionsSaving(false);
        }
    }

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center">
                <Loader2 className="size-8 animate-spin text-primary" />
            </div>
        );
    }

    if (!project) {
        return (
            <div className="flex h-screen flex-col items-center justify-center gap-4">
                <h1 className="text-2xl font-bold">Project Not Found</h1>
                <Button onClick={() => router.push("/dashboard/projects")}>
                    Back to Projects
                </Button>
            </div>
        );
    }

    const instructionsDirty = instructionsDraft !== (project.instructions || "");

    return (
        <div className="flex flex-1 flex-col gap-6 p-4 md:p-8 max-w-5xl mx-auto w-full overflow-y-auto">
            {/* Header */}
            <div className="flex items-start justify-between">
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="-ml-2 h-8 w-8"
                            onClick={() => router.push("/dashboard/projects")}
                        >
                            <ArrowLeft className="size-4" />
                        </Button>
                        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
                    </div>
                    <p className="text-muted-foreground">
                        {project.description || "No description provided."}
                    </p>
                </div>
            </div>

            {/* Instructions */}
            <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                    Instructions
                </h3>
                {instructionsStatus && (
                    <div
                        className={`rounded-md border px-3 py-2 text-sm ${
                            instructionsStatusTone === "error"
                                ? "border-destructive/40 bg-destructive/10 text-destructive"
                                : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        }`}
                    >
                        {instructionsStatus}
                    </div>
                )}
                <textarea
                    value={instructionsDraft}
                    onChange={(e) => setInstructionsDraft(e.target.value)}
                    placeholder="No custom instructions defined."
                    disabled={instructionsSaving}
                    className="min-h-[140px] w-full rounded-lg border bg-muted/50 p-4 text-sm font-mono whitespace-pre-wrap focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-70"
                />
                <div className="flex items-center gap-2">
                    <Button
                        size="sm"
                        onClick={handleSaveInstructions}
                        disabled={instructionsSaving || !instructionsDirty}
                        className="gap-2"
                    >
                        {instructionsSaving ? (
                            <>
                                <Loader2 className="size-4 animate-spin" />
                                Saving...
                            </>
                        ) : (
                            "Save"
                        )}
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setInstructionsDraft(project.instructions || "")}
                        disabled={instructionsSaving || !instructionsDirty}
                    >
                        Reset
                    </Button>
                </div>
            </div>

            {/* MCP + Skills */}
            <ProjectContextSection projectId={project.id} />

            {/* Cron Jobs */}
            <CronSection projectId={project.id} />

            {/* Knowledge Base */}
            <KnowledgeSection projectId={project.id} />

        </div>
    );
}
