import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeLogger } from "./logger.js";
import { audit } from "./audit.js";
import {
  createPlan,
  getPlan,
  updatePlan,
  listPlans,
  setPlanStepStatus,
  archivePlan,
  PlanStepStatus,
} from "./plans.js";

export function registerPlanTools(
  server: McpServer,
  rootDir: string,
  logger: BridgeLogger
): void {
  /**
   * Tool: create_plan
   */
  server.tool(
    "create_plan",
    "Create a new multi-step execution plan with background context and ordered steps.",
    {
      title: z.string().describe("Plan title"),
      context: z.string().optional().describe("Markdown background context and goals for the entire plan"),
      project_id: z.string().optional().describe("Optional project identifier to associate with the plan"),
      id: z.string().optional().describe("Optional custom plan ID (auto-generated if omitted)"),
      steps: z
        .array(
          z.object({
            id: z.string().optional().describe("Optional step identifier (e.g. step-1)"),
            title: z.string().describe("Step title"),
            detail: z.string().optional().describe("Detailed description / requirements for this step"),
            status: z
              .enum(["todo", "in_progress", "done", "failed", "skipped"])
              .optional()
              .describe("Initial step status (default: todo)"),
          })
        )
        .optional()
        .describe("Ordered list of steps for this plan"),
    },
    async ({ title, context, project_id, id, steps }) => {
      try {
        audit(rootDir, { tool: "create_plan" });
        const plan = createPlan(rootDir, {
          title,
          context,
          project_id,
          id,
          steps,
        });

        logger.info(`create_plan: created plan ${plan.id} ("${plan.title}") with ${plan.steps.length} steps`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(plan, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`create_plan error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error creating plan: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );

  /**
   * Tool: get_plan
   */
  server.tool(
    "get_plan",
    "Retrieve the full details, context, and all steps of a specific plan by ID.",
    {
      plan_id: z.string().describe("Plan ID to fetch"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ plan_id }) => {
      try {
        audit(rootDir, { tool: "get_plan", planId: plan_id });
        const plan = getPlan(rootDir, plan_id, { includeArchived: true });
        if (!plan) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error: Plan "${plan_id}" not found.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(plan, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`get_plan error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error retrieving plan: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );

  /**
   * Tool: update_plan
   */
  server.tool(
    "update_plan",
    "Update an existing plan's title, project_id, background context, or steps. Increments plan version by 1.",
    {
      plan_id: z.string().describe("Plan ID to update"),
      title: z.string().optional().describe("Updated plan title"),
      project_id: z.string().optional().describe("Updated project ID"),
      context: z.string().optional().describe("Updated markdown background context"),
      steps: z
        .array(
          z.object({
            id: z.string().optional().describe("Step ID (matches existing or creates new)"),
            title: z.string().describe("Step title"),
            detail: z.string().optional().describe("Step detail"),
            status: z
              .enum(["todo", "in_progress", "done", "failed", "skipped"])
              .optional()
              .describe("Step status"),
            task_ids: z.array(z.string()).optional(),
            pr_urls: z.array(z.string()).optional(),
          })
        )
        .optional()
        .describe("Updated steps array"),
    },
    async ({ plan_id, title, project_id, context, steps }) => {
      try {
        audit(rootDir, { tool: "update_plan", planId: plan_id });
        const updated = updatePlan(rootDir, plan_id, {
          title,
          project_id,
          context,
          steps,
        });

        logger.info(`update_plan: updated plan ${plan_id} (version now ${updated.version})`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(updated, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`update_plan error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error updating plan: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );

  /**
   * Tool: list_plans
   */
  server.tool(
    "list_plans",
    "List plans in compact summary form (omits full markdown context), optionally filtered by project_id.",
    {
      project_id: z.string().optional().describe("Optional project ID to filter plans"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ project_id }) => {
      try {
        audit(rootDir, { tool: "list_plans" });
        const summaries = listPlans(rootDir, {
          projectId: project_id?.trim(),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(summaries, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`list_plans error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error listing plans: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );

  /**
   * Tool: set_plan_step_status
   */
  server.tool(
    "set_plan_step_status",
    "Update the status of a single step within a plan, optionally appending task_id and pr_url. Increments plan version by 1.",
    {
      plan_id: z.string().describe("Plan ID"),
      step_id: z.string().describe("Step ID within the plan"),
      status: z
        .enum(["todo", "in_progress", "done", "failed", "skipped"])
        .describe("New step status"),
      task_id: z.string().optional().describe("Optional task ID to append to step task_ids"),
      pr_url: z.string().optional().describe("Optional PR URL to append to step pr_urls"),
    },
    async ({ plan_id, step_id, status, task_id, pr_url }) => {
      try {
        audit(rootDir, { tool: "set_plan_step_status", planId: plan_id, state: status });
        const res = setPlanStepStatus(
          rootDir,
          plan_id.trim(),
          step_id.trim(),
          status as PlanStepStatus,
          {
            taskId: task_id?.trim(),
            prUrl: pr_url?.trim(),
          }
        );

        logger.info(`set_plan_step_status: updated ${plan_id}/${step_id} to ${status}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  plan_id,
                  step_id,
                  status,
                  version: res.plan.version,
                  step: res.step,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`set_plan_step_status error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error setting plan step status: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );

  /**
   * Tool: archive_plan
   */
  server.tool(
    "archive_plan",
    "Archive a plan. Refuses if any associated task is currently running or queued.",
    {
      plan_id: z.string().describe("Plan ID to archive"),
    },
    async ({ plan_id }) => {
      try {
        audit(rootDir, { tool: "archive_plan", planId: plan_id });
        const res = archivePlan(rootDir, plan_id.trim());
        if (!res.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: res.error || `Failed to archive plan "${plan_id}".`,
              },
            ],
          };
        }

        logger.info(`archive_plan: archived plan ${plan_id}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(res, null, 2),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`archive_plan error: ${err?.message || String(err)}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error archiving plan: ${err?.message || String(err)}`,
            },
          ],
        };
      }
    }
  );
}
