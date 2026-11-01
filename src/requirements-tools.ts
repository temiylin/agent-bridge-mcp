import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeLogger } from "./logger.js";
import {
  writeRequirement,
  getRequirement,
  listRequirements,
  deleteRequirement,
  generateRequirementId,
  isValidRequirementId,
  RequirementRecord,
  RequirementStatus,
} from "./requirements.js";
import { dispatchTaskDirect, isSessionBusy } from "./queue-dispatcher.js";
import { enqueueTask } from "./queue.js";

export function registerRequirementsTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  /**
   * Tool: save_requirement
   * Stashes a requirement draft under requirements/<id>.json.
   */
  server.tool(
    "save_requirement",
    "Save a requirement to the backlog for later review and dispatch.",
    {
      project: z.string().optional().describe("Project identifier or name (legacy parameter)"),
      project_id: z.string().optional().describe("Project identifier (e.g. 'vision_hub')"),
      topic: z.string().optional().describe("Optional topic or session_id to group requirements"),
      session_id: z.string().optional().describe("Optional session_id (alias for topic)"),
      title: z.string().describe("Requirement title"),
      raw_text: z.string().describe("Full raw requirement specification text"),
      tags: z.array(z.string()).optional().describe("Optional category or keyword tags"),
    },
    async ({ project, project_id, topic, session_id, title, raw_text, tags }) => {
      try {
        const effectiveProject = (project_id && project_id.trim()) || (project && project.trim());
        if (!effectiveProject) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: project or project_id must be a non-empty string." }],
          };
        }
        if (!title || title.trim().length === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: title must be a non-empty string." }],
          };
        }
        if (!raw_text || raw_text.trim().length === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: raw_text must be a non-empty string." }],
          };
        }

        const effectiveTopic = (topic && topic.trim()) || (session_id && session_id.trim()) || undefined;
        const id = generateRequirementId();
        const createdAt = new Date().toISOString();

        const record: RequirementRecord = {
          id,
          project: effectiveProject,
          topic: effectiveTopic,
          session_id: effectiveTopic,
          title: title.trim(),
          raw_text: raw_text.trim(),
          tags: tags && Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : undefined,
          status: "draft",
          created_at: createdAt,
        };

        writeRequirement(rootDir, record);
        logger.info(`save_requirement: saved requirement ${id} (project=${record.project})`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ id, status: "draft" }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`save_requirement error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error saving requirement: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: list_requirements
   * Returns a compact list (no full raw_text) filtered by project, topic, status.
   */
  server.tool(
    "list_requirements",
    "List stored requirements in compact form (omits full raw text).",
    {
      project: z.string().optional().describe("Filter by project name (legacy parameter)"),
      project_id: z.string().optional().describe("Filter by project ID or name (e.g. 'vision_hub')"),
      topic: z.string().optional().describe("Filter by topic or session_id"),
      status: z
        .enum(["draft", "dispatched", "merged", "archived"])
        .optional()
        .describe("Filter by requirement status"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ project, project_id, topic, status }) => {
      try {
        const effectiveProject = (project_id && project_id.trim()) || (project && project.trim());
        const compactList = listRequirements(rootDir, {
          project: effectiveProject,
          topic: topic?.trim(),
          status: status as RequirementStatus,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(compactList, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`list_requirements error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error listing requirements: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: get_requirement
   * Returns full record for a specific requirement id.
   */
  server.tool(
    "get_requirement",
    "Retrieve the full details of a specific requirement by ID.",
    {
      id: z.string().describe("Requirement ID"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ id }) => {
      try {
        if (!isValidRequirementId(id)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Invalid requirement ID "${id}".` }],
          };
        }

        const record = getRequirement(rootDir, id);
        if (!record) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Requirement "${id}" not found.` }],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(record, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`get_requirement error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error getting requirement: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: update_requirement
   * Updates fields of an existing requirement.
   */
  server.tool(
    "update_requirement",
    "Update fields (title, raw_text, tags, topic, status) of an existing requirement.",
    {
      id: z.string().describe("Requirement ID to update"),
      title: z.string().optional().describe("New title"),
      raw_text: z.string().optional().describe("New raw_text"),
      tags: z.array(z.string()).optional().describe("New tags array"),
      topic: z.string().optional().describe("New topic or session_id"),
      project: z.string().optional().describe("New project (legacy)"),
      project_id: z.string().optional().describe("New project ID or name"),
      status: z.enum(["draft", "dispatched", "merged", "archived"]).optional().describe("New status"),
    },
    async ({ id, title, raw_text, tags, topic, project, project_id, status }) => {
      try {
        if (!isValidRequirementId(id)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Invalid requirement ID "${id}".` }],
          };
        }

        const record = getRequirement(rootDir, id);
        if (!record) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Requirement "${id}" not found.` }],
          };
        }

        if (title !== undefined) record.title = title.trim();
        if (raw_text !== undefined) record.raw_text = raw_text.trim();
        if (tags !== undefined) record.tags = tags.map((t) => String(t).trim()).filter(Boolean);
        if (topic !== undefined) {
          record.topic = topic.trim();
          record.session_id = topic.trim();
        }
        const effectiveProjectUpdate = (project_id && project_id.trim()) || (project && project.trim());
        if (effectiveProjectUpdate !== undefined && effectiveProjectUpdate.length > 0) {
          record.project = effectiveProjectUpdate;
        }
        if (status !== undefined) record.status = status;
        record.updated_at = new Date().toISOString();

        writeRequirement(rootDir, record);
        logger.info(`update_requirement: updated requirement ${id}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ id: record.id, status: record.status, updated_at: record.updated_at }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`update_requirement error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error updating requirement: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: merge_requirements
   * Merges multiple requirement records into a new one. Original records are marked as "merged".
   */
  server.tool(
    "merge_requirements",
    "Merge multiple requirements into a new consolidated requirement, marking source records as merged.",
    {
      ids: z.array(z.string()).min(2).describe("Array of requirement IDs to merge"),
      title: z.string().optional().describe("Title for the new merged requirement"),
    },
    async ({ ids, title }) => {
      try {
        const records: RequirementRecord[] = [];
        for (const reqId of ids) {
          if (!isValidRequirementId(reqId)) {
            return {
              isError: true,
              content: [{ type: "text", text: `Error: Invalid requirement ID "${reqId}".` }],
            };
          }
          const rec = getRequirement(rootDir, reqId);
          if (!rec) {
            return {
              isError: true,
              content: [{ type: "text", text: `Error: Requirement "${reqId}" not found.` }],
            };
          }
          records.push(rec);
        }

        const newId = generateRequirementId();
        const mergedTitle = title && title.trim().length > 0 ? title.trim() : `Merged Requirement (${records.map((r) => r.id).join(", ")})`;
        const primaryProject = records[0].project;
        const primaryTopic = records[0].topic || records[0].session_id;

        // Combine raw texts and tags
        const combinedText = records
          .map((r) => `### Source: ${r.id} (${r.title})\n\n${r.raw_text}`)
          .join("\n\n---\n\n");

        const combinedTags = Array.from(
          new Set(records.flatMap((r) => r.tags || []).filter(Boolean))
        );

        const newRecord: RequirementRecord = {
          id: newId,
          project: primaryProject,
          topic: primaryTopic,
          session_id: primaryTopic,
          title: mergedTitle,
          raw_text: combinedText,
          tags: combinedTags.length > 0 ? combinedTags : undefined,
          status: "draft",
          created_at: new Date().toISOString(),
          merged_from: records.map((r) => r.id),
        };

        writeRequirement(rootDir, newRecord);

        // Mark source records as merged with pointer to new record
        for (const src of records) {
          src.status = "merged";
          src.merged_into = newId;
          src.updated_at = new Date().toISOString();
          writeRequirement(rootDir, src);
        }

        logger.info(`merge_requirements: merged [${ids.join(", ")}] into ${newId}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: newId,
                  title: newRecord.title,
                  status: "draft",
                  merged_from: records.map((r) => r.id),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`merge_requirements error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error merging requirements: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: archive_requirement
   * Sets requirement status to "archived".
   */
  server.tool(
    "archive_requirement",
    "Archive a requirement (status -> archived).",
    {
      id: z.string().describe("Requirement ID to archive"),
    },
    async ({ id }) => {
      try {
        if (!isValidRequirementId(id)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Invalid requirement ID "${id}".` }],
          };
        }

        const record = getRequirement(rootDir, id);
        if (!record) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Requirement "${id}" not found.` }],
          };
        }

        record.status = "archived";
        record.updated_at = new Date().toISOString();
        writeRequirement(rootDir, record);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ id, status: "archived" }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`archive_requirement error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error archiving requirement: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: delete_requirement
   * Permanently deletes a requirement record.
   */
  server.tool(
    "delete_requirement",
    "Permanently delete a requirement record.",
    {
      id: z.string().describe("Requirement ID to delete"),
    },
    async ({ id }) => {
      try {
        if (!isValidRequirementId(id)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Invalid requirement ID "${id}".` }],
          };
        }

        const success = deleteRequirement(rootDir, id);
        if (!success) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Requirement "${id}" not found or could not be deleted.` }],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ id, deleted: true }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`delete_requirement error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error deleting requirement: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  /**
   * Tool: dispatch_requirement
   * Dispatches a requirement as an agent task reusing the topic's session_id.
   * If `queue_if_busy` is true and the session is busy, enqueues it instead.
   */
  server.tool(
    "dispatch_requirement",
    "Dispatch a requirement into an executable agent task. Reuses topic/session_id to continue conversation if present. Optionally enqueues if session is busy.",
    {
      id: z.string().describe("Requirement ID to dispatch"),
      agent: z.string().optional().describe("Optional agent name override"),
      options: z
        .object({
          project_id: z.string().optional().describe("Optional project_id override (defaults to requirement.project)"),
          plan_id: z.string().optional().describe("Optional plan_id to link this requirement dispatch to an execution plan"),
          step_id: z.string().optional().describe("Optional step_id within the plan"),
          model: z.string().optional(),
          reasoning_effort: z.string().optional(),
          account: z.string().optional().describe("Optional agy account profile alias or 'auto'"),
          queue_if_busy: z.boolean().optional(),
          on_complete: z
            .object({
              url: z.string().describe("Destination webhook URL (must be http/https)"),
              headers: z.record(z.string(), z.string()).optional(),
              events: z.array(z.enum(["completed", "failed", "pr_opened"])).optional(),
              secret: z.string().optional(),
            })
            .optional()
            .describe("Opt-in per task completion webhook. Opt-in per task; do not enable globally; only callers that have a webhook (e.g. Grok Bot) should pass on_complete."),
        })
        .optional()
        .describe("Optional execution settings, project/plan linkage, queuing options, and opt-in webhook"),
    },
    async ({ id, agent, options }) => {
      try {
        if (!isValidRequirementId(id)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Invalid requirement ID "${id}".` }],
          };
        }

        const record = getRequirement(rootDir, id);
        if (!record) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Requirement "${id}" not found.` }],
          };
        }

        const effectiveSessionId = record.session_id || record.topic;
        const queueIfBusy = options?.queue_if_busy === true;
        const effectiveProjectId =
          (options?.project_id && options.project_id.trim()) ||
          (record.project && record.project.trim()) ||
          undefined;

        if (effectiveSessionId && queueIfBusy && isSessionBusy(rootDir, effectiveSessionId)) {
          // Enqueue instead
          const enqRes = enqueueTask(rootDir, {
            session_id: effectiveSessionId,
            prompt: record.raw_text,
            options: {
              title: record.title,
              agent,
              model: options?.model,
              reasoning_effort: options?.reasoning_effort,
              account: options?.account,
              requirement_id: record.id,
              project_id: effectiveProjectId,
              plan_id: options?.plan_id,
              step_id: options?.step_id,
              on_complete: options?.on_complete,
            },
            mode: "auto",
          });

          logger.info(`dispatch_requirement: session ${effectiveSessionId} is busy, enqueued requirement ${id} as item ${enqRes.id} (project=${effectiveProjectId})`);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    id: record.id,
                    status: "queued",
                    queued_item_id: enqRes.id,
                    position: enqRes.position,
                    session_id: effectiveSessionId,
                    project_id: effectiveProjectId,
                    plan_id: options?.plan_id,
                    step_id: options?.step_id,
                    message: `Session is busy. Enqueued requirement for auto-dispatch.`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Dispatch immediately
        const dispatchRes = dispatchTaskDirect(rootDir, {
          prompt: record.raw_text,
          title: record.title,
          agent,
          model: options?.model,
          reasoning_effort: options?.reasoning_effort,
          continue_session: !!effectiveSessionId,
          session_id: effectiveSessionId,
          account: options?.account,
          project_id: effectiveProjectId,
          plan_id: options?.plan_id,
          step_id: options?.step_id,
          on_complete: options?.on_complete,
        });

        const now = new Date().toISOString();
        record.status = "dispatched";
        record.task_id = dispatchRes.taskId;
        record.dispatched_at = now;
        record.updated_at = now;
        writeRequirement(rootDir, record);

        logger.info(`dispatch_requirement: dispatched requirement ${id} as taskId ${dispatchRes.taskId} (project=${effectiveProjectId})`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: record.id,
                  status: "dispatched",
                  task_id: dispatchRes.taskId,
                  dispatched_at: now,
                  agent: dispatchRes.agentName,
                  session_id: effectiveSessionId,
                  project_id: effectiveProjectId,
                  plan_id: options?.plan_id,
                  step_id: options?.step_id,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`dispatch_requirement error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error dispatching requirement: ${err?.message || String(err)}` }],
        };
      }
    }
  );
}
