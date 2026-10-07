/** The subset of Nest's Logger the plumbing needs; keeps libs/messaging free of Nest. */
export interface LoggerLike {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
