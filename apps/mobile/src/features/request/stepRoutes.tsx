import type { ReactNode } from "react";

import { DescribeStep } from "./DescribeStep";
import { FlowFallback } from "./FlowFallback";
import { QuestionsStep } from "./QuestionsStep";
import { ReviewStep } from "./ReviewStep";
import { useRequestFlow, type RequestFlowState } from "./useRequestFlow";
import { WhenStep } from "./WhenStep";
import { WhereStep } from "./WhereStep";

type ReadyFlow = Extract<RequestFlowState, { status: "ready" }>;

/** A step route: the step once the flow's category is known, its fallback until then. */
function withFlow(render: (flow: ReadyFlow) => ReactNode) {
  return function StepRoute() {
    const flow = useRequestFlow();
    return flow.status === "ready" ? render(flow) : <FlowFallback flow={flow} />;
  };
}

/** `/request/new`, where home's category card lands: the questions, or Describe without any. */
export const FirstStepRoute = withFlow(({ category, steps }) =>
  steps[0] === "questions" ? (
    <QuestionsStep category={category} steps={steps} />
  ) : (
    <DescribeStep steps={steps} />
  ),
);

export const DescribeRoute = withFlow(({ steps }) => <DescribeStep steps={steps} />);
export const WhereRoute = withFlow(({ steps }) => <WhereStep steps={steps} />);
export const WhenRoute = withFlow(({ steps }) => <WhenStep steps={steps} />);
export const ReviewRoute = withFlow(({ category, steps }) => (
  <ReviewStep category={category} steps={steps} />
));
