/** Errors that mean "this model can't serve right now", shared by providers and adapters. */
export class ModelUnavailableError extends Error {
  override name = "ModelUnavailableError";
}
