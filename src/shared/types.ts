export type WdytEventType = "click" | "input" | "change" | "submit" | "navigate";

export type WdytEvent = {
  type: WdytEventType;
  ts: number;
  seq: number;
  url?: string;
  target?: {
    tag: string;
    text: string | null;
  };
};

export type SuiteInfo = {
  id: string;
  name: string;
  normalizedName: string;
};

export type RunInfo = {
  id: string;
  testName: string;
  startedAt: number;
  endedAt: number;
  reason: "completed" | "timeout";
};

export type BrowserInfo = {
  family: string;
  version: string;
  source: "bootstrap-request";
};

export type RunEnvironment = {
  browser?: BrowserInfo;
  tool?: string;
};

export type RunEndState = {
  finalUrl?: string;
  title?: string | null;
  heading?: string | null;
  alertText?: string | null;
};

export type StartRunRequest = {
  suiteName: string;
  testName: string;
  environment?: RunEnvironment;
};

export type StartRunResponse = {
  runId: string;
  bootstrapUrl: string;
};

export type EndRunRequest = {
  runId: string;
  reason?: "completed" | "timeout";
};

export type IngestPayload = {
  suite: SuiteInfo;
  run: RunInfo;
  environment?: RunEnvironment;
  endState?: RunEndState;
  events: WdytEvent[];
};

export type ReducedStep = "CLICK" | "INPUT" | "CHANGE" | "SUBMIT" | "NAVIGATE";

export type ProcessedRunRecord = {
  runId: string;
  suite: SuiteInfo;
  environment?: RunEnvironment;
  endState?: RunEndState;
  reduced: ReducedStep[];
  canonical: ReducedStep[];
  flowId: string;
  meta: {
    canonicalSource: "reducer";
  };
};

export type DescriptorStatus = "pending" | "approved" | "rejected" | "overridden";

export type FlowReviewRecord = {
  reviewId: string;
  flowId: string;
  variantSignature?: string;
  canonical: ReducedStep[];
  proposedDescriptor: string;
  proposedConfidence?: number;
  proposedRationale?: string;
  descriptorStatus: DescriptorStatus;
  approvedDescriptor?: string;
  notes?: string;
  approvedVocabUsed: string[];
  usedVocab?: string[];
  proposedVocab: string[];
  updatedAt: number;
};

export type VocabularyStatus = "approved" | "rejected" | "proposed";

export type VocabularyEntry = {
  term: string;
  status: VocabularyStatus;
  description?: string;
  aliases?: string[];
  updatedAt: number;
};

export type FlowDescriptorProposal = {
  descriptor: string;
  approvedVocab: string[];
  proposedVocab: string[];
  confidence: number;
  rationale: string;
};

export type ReviewProposalState = "pending" | "processing" | "proposed" | "error";

export type ReviewDecisionStatus = "pending" | "approved" | "rejected" | "overridden";

export type ReviewUnitRecord = {
  reviewId: string;
  flowId: string;
  variantSignature?: string;
  canonical: ReducedStep[];
  count: number;
  suites: string[];
  tests: string[];
  tools: string[];
  browsers: string[];
  urls: string[];
  targets: string[];
  finalUrls: string[];
  titles: string[];
  headings: string[];
  alerts: string[];
  proposalState: ReviewProposalState;
  proposedDescriptor?: string;
  proposedConfidence?: number;
  proposedRationale?: string;
  candidateVocab?: string[];
  approvedVocabUsed: string[];
  proposedVocab: string[];
  proposalError?: string;
  reviewStatus: ReviewDecisionStatus;
  approvedDescriptor?: string;
  notes?: string;
  updatedAt: number;
  proposedAt?: number;
  reviewedAt?: number;
};

export type CriticalFlowStatus = "missing" | "partial" | "covered";

export type ParsedCriticalFlow = {
  name: string;
  rawText: string;
  interpretedSteps: string[];
  interpretedTerms: string[];
  outcome?: string;
};

export type CriticalFlowRecord = ParsedCriticalFlow & {
  id: string;
  status: CriticalFlowStatus;
  matchedDescriptorIds: string[];
  updatedAt: number;
};

export type ApprovedDescriptorRecord = {
  id: string;
  name: string;
  vocab: string[];
};

export type CriticalFlowDetailRecord = CriticalFlowRecord & {
  matchedDescriptors: ApprovedDescriptorRecord[];
  matchedConcepts: string[];
  missingTerms: string[];
};
