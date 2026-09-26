/** The rejection reason of a promise that must reject (fails the test if it resolves). */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error value: ${String(error)}`);
  }
  throw new Error("expected the promise to reject");
}
