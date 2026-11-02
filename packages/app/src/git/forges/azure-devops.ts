import { z } from "zod";
import {
  defineForgeFacts,
  type ClientForgeLogicModule,
  type MergeCapability,
} from "@/git/client-forge-module";
import type { CheckoutPrMergeMethod } from "@getpaseo/protocol/messages";

const MERGE_METHODS = [
  "merge",
  "squash",
  "rebase",
] as const satisfies readonly CheckoutPrMergeMethod[];

const AzureDevOpsMergeFactsSchema = z
  .object({
    forge: z.literal("azure-devops"),
    status: z.string().optional().default("active"),
    mergeStatus: z.string().nullable().optional().default(null),
    isDraft: z.boolean().optional().default(false),
    autoCompleteEnabled: z.boolean().optional().default(false),
    blockingPoliciesPassed: z.boolean().optional().default(false),
    allowedMethods: z
      .array(z.enum(MERGE_METHODS))
      .optional()
      .default([...MERGE_METHODS]),
  })
  .passthrough();

type AzureDevOpsMergeFacts = z.infer<typeof AzureDevOpsMergeFactsSchema>;

export function deriveAzureDevOpsMergeCapability(facts: AzureDevOpsMergeFacts): MergeCapability {
  const active = facts.status === "active" && !facts.isDraft;
  return {
    directMergeReady:
      active &&
      !facts.autoCompleteEnabled &&
      facts.mergeStatus === "succeeded" &&
      facts.blockingPoliciesPassed,
    canEnableAutoMerge: active && !facts.autoCompleteEnabled,
    autoMergeEnabled: facts.autoCompleteEnabled,
    canDisableAutoMerge: facts.status === "active" && facts.autoCompleteEnabled,
    mergeBlockedByQueue: false,
    allowedMethods: facts.allowedMethods,
    preferredMethod: null,
  };
}

export const azureDevOpsForgeLogic = {
  id: "azure-devops",
  facts: defineForgeFacts({
    family: "azure-devops",
    schema: AzureDevOpsMergeFactsSchema,
    deriveMergeCapability: deriveAzureDevOpsMergeCapability,
  }),
} satisfies ClientForgeLogicModule<AzureDevOpsMergeFacts>;
