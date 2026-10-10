import { Parsers, type LiveE2eConfig } from "@github-webhook-relay/core";

export function readConfig(
  environment: Readonly<Record<string, string | null | undefined>>,
): LiveE2eConfig {
  return Parsers.LiveE2eConfig.parse({
    relayUrl: environment.RELAY_URL,
    alternateRelayUrl: environment.ALTERNATE_RELAY_URL,
    githubToken: environment.GITHUB_E2E_TOKEN,
    githubRepository: environment.GITHUB_E2E_REPOSITORY,
    githubHookId: environment.GITHUB_E2E_HOOK_ID,
    accessClientId: environment.CF_ACCESS_CLIENT_ID,
    accessClientSecret: environment.CF_ACCESS_CLIENT_SECRET,
    stateDirectory: environment.GH_WATCH_STATE_DIRECTORY,
    testedCommit: environment.TESTED_COMMIT,
    actionsRunUrl: environment.ACTIONS_RUN_URL,
  });
}
