/** Horloge injectable : permet de tester le minuteur sans attendre réellement. */
export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
};
