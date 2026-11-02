import { AzureDevOpsIcon } from "@/components/icons/azure-devops-icon";
import type { ClientForgeViewModule } from "@/git/client-forge-module";

export const azureDevOpsForgeView = {
  id: "azure-devops",
  icon: AzureDevOpsIcon,
  brandColor: {
    light: "#0078D4",
    dark: "#3A96DD",
  },
} satisfies ClientForgeViewModule;
