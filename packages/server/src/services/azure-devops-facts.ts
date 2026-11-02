import type { ForgeSpecificStatusFacts } from "./forge-service.js";

export type AzureDevOpsMergeMethod = "merge" | "squash" | "rebase";

export interface AzureDevOpsStatusFacts {
  status: string;
  mergeStatus: string | null;
  isDraft: boolean;
  autoCompleteEnabled: boolean;
  blockingPoliciesPassed: boolean;
  allowedMethods: AzureDevOpsMergeMethod[];
}

export type AzureDevOpsForgeSpecificStatusFacts = ForgeSpecificStatusFacts & {
  forge: "azure-devops";
} & AzureDevOpsStatusFacts;

export function isAzureDevOpsStatusFacts(
  facts: ForgeSpecificStatusFacts | null | undefined,
): facts is AzureDevOpsForgeSpecificStatusFacts {
  return facts?.forge === "azure-devops";
}
