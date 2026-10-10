import parse from "./generated/parser";

export type GitHubActionPayload = Readonly<{
  action: string;
}>;

export type GitHubRepositoryPayload = Readonly<{
  repository: Readonly<{
    full_name: string;
  }>;
}>;

export type GitHubPullRequestPayload = Readonly<{
  action: "closed";
  pull_request: Readonly<{
    merged: true;
  }>;
  repository: Readonly<{
    full_name: string;
  }>;
}>;

export type GitHubPullRequestSelection = Readonly<{
  pull_request: Readonly<{
    merged: boolean;
  }>;
}>;

export type RawEventQuery = Readonly<{
  after?: string;
  limit?: string;
  repository?: string;
  type?: string;
}>;

export type StreamAttachmentData = Readonly<{
  bytes: number;
  connectionKey: string;
  cursor: string;
  positions: number;
}>;

export const GitHubParsers = parse.buildParsers<{
  GitHubActionPayload: GitHubActionPayload;
  GitHubRepositoryPayload: GitHubRepositoryPayload;
  GitHubPullRequestPayload: GitHubPullRequestPayload;
  GitHubPullRequestSelection: GitHubPullRequestSelection;
  RawEventQuery: RawEventQuery;
  StreamAttachmentData: StreamAttachmentData;
}>();
