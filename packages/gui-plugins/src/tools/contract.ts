// What other built-ins may reuse from the Tools plugin: pure helpers over the publishing status, no views or components.
// The preview's Publish dialog reads them, so its stepper, address and times match the Publishing tool's.

export { ago, duration, liveAddress, slug, stepState, STEPS, type Step, type StepState } from "./publish/model"
