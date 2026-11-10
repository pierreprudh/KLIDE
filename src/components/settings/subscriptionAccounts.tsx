import type { ReactNode } from "react";
import type { ProviderId } from "../../agent/types";
import { ProviderLogo } from "../ai/icons";
import { AccountControl, GitHubAccountRow } from "./accounts";
import { GhostButton, Panel, Row, SettingBlock, StatusText } from "./controls";
import { ProviderWordmark } from "./providerWordmarks";

type Provider = { id: string; title: string; description: string; accounts: boolean };
type Status = { installed: boolean; connected: boolean; detail: string };
type OllamaAccount = { running: boolean; signedIn: boolean; name?: string | null; detail: string };

function AccountGroup({ title, description, action, children }: {
  title: string; description: string; action?: ReactNode; children: ReactNode;
}) {
  return (
    <SettingBlock title={title} action={action}>
      <p className="klide-row-description" style={{ margin: "0 0 12px" }}>{description}</p>
      <Panel>{children}</Panel>
    </SettingBlock>
  );
}

export function SubscriptionAccounts({ providers, statuses, ollamaAccount, refreshing, onRefresh }: {
  providers: Provider[];
  statuses: Partial<Record<string, Status>>;
  ollamaAccount: OllamaAccount | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="klide-subscription-accounts" data-setting="Connections & Accounts" tabIndex={-1}>
      <AccountGroup title="Workspace identity" description="Your GitHub account for pull requests and repository access.">
        <GitHubAccountRow />
      </AccountGroup>
      <AccountGroup title="Coding agents" description="Use your existing CLI logins. Save an account to switch between work and personal."
        action={<GhostButton onClick={onRefresh} disabled={refreshing}>{refreshing ? "Checking…" : "Refresh"}</GhostButton>}>
        <div aria-busy={refreshing}>
          {providers.map((provider) => {
            const status = statuses[provider.id];
            return <Row key={provider.id} title={provider.title}
              titleContent={<ProviderWordmark id={provider.id} label={provider.title} />}
              description={status?.detail || provider.description}
              leading={<ProviderLogo id={provider.id as ProviderId} size={24} />}
              control={provider.accounts ? (
                <AccountControl provider={provider.id} title={provider.title} connected={!!status?.connected} />
              ) : (
                <StatusText tone={status?.connected ? "ok" : "idle"}>
                  {status?.connected ? "Ready" : status?.installed ? "Not connected" : "Not installed"}
                </StatusText>
              )} />;
          })}
        </div>
      </AccountGroup>
      <AccountGroup title="Cloud access" description="Your ollama.com account for cloud models and model pushes.">
        <Row title="Ollama" titleContent={<ProviderWordmark id="ollama" label="Ollama" />} description={ollamaAccount?.detail ?? "Sign in with ollama signin in a terminal."}
          leading={<ProviderLogo id={"ollama" as ProviderId} size={24} />}
          control={<StatusText tone={ollamaAccount?.signedIn ? "ok" : ollamaAccount?.running ? "warn" : "idle"}>
            {ollamaAccount?.signedIn ? ollamaAccount.name ?? "Signed in" : ollamaAccount?.running ? "Not signed in" : "Server offline"}
          </StatusText>} />
      </AccountGroup>
    </div>
  );
}
