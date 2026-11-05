const unsupportedCopilotFfi = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "Agent Teams uses the Copilot CLI over stdio; its in-process FFI transport is unavailable.",
      );
    },
  },
);

export default unsupportedCopilotFfi;
