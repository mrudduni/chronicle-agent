/**
 * The one place the code asks "what time is it?".
 *
 * Injecting a Clock instead of calling Date.now() everywhere is what makes the
 * time logic testable: tests and evals use a FixedClock and get the same
 * answer every run.
 */
export interface Clock {
  now(): number;
  readonly frozen: boolean;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  frozen: false,
};

/** A clock that only moves when told to. Used by tests, evals and the NOW env var. */
export class FixedClock implements Clock {
  readonly frozen = true;
  private ms: number;

  constructor(at: string | number) {
    this.ms = typeof at === "number" ? at : Date.parse(at);
    if (Number.isNaN(this.ms)) throw new Error(`FixedClock: cannot parse time "${at}"`);
  }

  now() {
    return this.ms;
  }

  set(at: string | number) {
    this.ms = typeof at === "number" ? at : Date.parse(at);
  }

  advance(ms: number) {
    this.ms += ms;
  }
}
