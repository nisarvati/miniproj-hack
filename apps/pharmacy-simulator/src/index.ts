export { PharmacySimulator, type ChangeResult, type RecordedEvent, type StockLine } from "./simulator.js";
export { FlowTracer, type EventTrace, type FollowOptions, type Hint, type Stage, type StageUpdate, type TracerDeps } from "./tracer.js";
export { compareStock, waitUntilInSync, type ComparedItem, type Comparison } from "./compare.js";
export { startEmbeddedPipeline, type Component, type EmbeddedOptions, type EmbeddedPipeline } from "./pipeline.js";
export { Shell, HELP, type RunResult, type ShellDeps } from "./shell.js";
export { SimulatorError, resolveMedicine, resolvePharmacy } from "./catalogue.js";
