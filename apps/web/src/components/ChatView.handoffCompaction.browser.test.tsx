import { createMemoryHistory } from "@tanstack/react-router";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  dispatchedCommands,
  emitThreadEvent,
  userItem,
  assistantItem,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/** A Claude thread whose 250k-token context went cold long ago, with its native thread kept for handoff. */
function coldClaudeThread(threadId = "thread-claude") {
  const thread = threadWithHistory(threadId, 3, {
    instanceId: CLAUDE,
    model: "claude-opus-4-6",
  });
  const at = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");
  const providerThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("provider-thread-claude"),
    driver: CLAUDE_DRIVER,
    providerInstanceId: CLAUDE,
    providerSessionId: null,
    appThreadId: thread.id,
    ownerNodeId: null,
    nativeThreadRef: { driver: CLAUDE_DRIVER, nativeId: "native-claude", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 3,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: { usedTokens: 250_000, maxTokens: 1_000_000 },
    nativeMetadata: null,
    goal: null,
    createdAt: at,
    updatedAt: at,
  };
  return { ...thread, providerThreads: [providerThread] };
}

it.each(["direct", "brief", "interrupt", "unavailable"] as const)(
  "sends a Codex follow-up without compacting: %s",
  async (flow) => {
    const cold = coldClaudeThread(`thread-claude-${flow}`);
    const thread =
      flow === "unavailable"
        ? {
            ...cold,
            runs: cold.runs.map((run) => ({
              ...run,
              modelSelection: { ...run.modelSelection, model: "retired-model" },
            })),
          }
        : cold;
    using _environment = installFakeEnvironment([thread], {
      acceptCommands: true,
      providers: [CLAUDE_PROVIDER, CODEX_PROVIDER],
    });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      followUpBehavior: "steer",
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
    );
    await router.load();
    await using _app = await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    });
    await expect.element(page.getByText(`Answer 2 for ${thread.id}.`)).toBeVisible();
    const compactAndSend = page.getByRole("button", { name: "Compact and send" });
    await expect.element(compactAndSend).toBeVisible();

    await page.getByRole("button", { name: "Claude Opus 4.6", exact: true }).click();
    // The picker lists only the active provider's models until you search.
    await userEvent.type(page.getByPlaceholder("Search models..."), "GPT-5.4");
    await page.getByRole("option", { name: "GPT-5.4", exact: false }).click();
    await expect.element(page.getByRole("button", { name: "GPT-5.4", exact: true })).toBeVisible();
    await expect.element(compactAndSend).not.toBeInTheDocument();
    // Picking a model leaves the composer's settings menu open.
    await userEvent.keyboard("{Escape}");

    const editor = page.getByTestId("composer-editor");
    await userEvent.click(editor);
    await userEvent.type(editor, "keep going");
    const messages = () =>
      dispatchedCommands().flatMap((command) =>
        command.type === "message.dispatch"
          ? [{ text: command.text, instanceId: command.modelSelection?.instanceId }]
          : [],
      );
    const ask = page.getByRole("button", { name: "Ask outgoing model for a brief" });
    expect(messages()).toEqual([]);
    if (flow === "unavailable") await expect.element(ask).not.toBeInTheDocument();
    const withBrief = flow === "brief" || flow === "interrupt";
    if (withBrief) {
      await ask.click();
      await vi.waitFor(() =>
        expect(messages()).toEqual([
          { instanceId: CLAUDE, text: expect.stringContaining("handoff brief") },
        ]),
      );
      const request = dispatchedCommands().find((command) => command.type === "message.dispatch")!;
      expect(request.attachments).toEqual([]);
      const run = {
        ...thread.runs.at(-1)!,
        ordinal: 4,
        id: RunId.make("brief-run"),
        userMessageId: request.messageId,
      };
      await emitThreadEvent(thread.id, {
        type: "run.created",
        payload: { ...run, status: "running", completedAt: null },
      });
      await emitThreadEvent(thread.id, {
        type: "turn-item.updated",
        payload: userItem(thread.id, run.id, request.messageId, 6, request.text),
      });
      await expect
        .element(page.getByRole("button", { name: "Stop generation", exact: true }))
        .toBeVisible();
      await userEvent.click(editor);
      // Even with steering as the default, a message for the destination waits for the brief.
      await expect
        .element(page.getByRole("button", { name: "Queue message", exact: true }))
        .toBeVisible();
      if (flow === "interrupt") {
        await page.getByRole("button", { name: "Stop generation", exact: true }).click();
        await vi.waitFor(() =>
          expect(dispatchedCommands()).toContainEqual(
            expect.objectContaining({ type: "run.interrupt", runId: run.id, holdQueue: true }),
          ),
        );
        await emitThreadEvent(thread.id, {
          type: "run.updated",
          payload: { ...run, status: "interrupted" },
        });
        await expect.element(ask).toBeVisible();
      } else {
        await emitThreadEvent(thread.id, {
          type: "turn-item.updated",
          payload: assistantItem(
            thread.id,
            run.id,
            "brief-answer",
            7,
            "Verified work and next steps.",
          ),
        });
        await expect.element(page.getByText("Verified work and next steps.")).toBeVisible();
        await emitThreadEvent(thread.id, { type: "run.updated", payload: run });
        await expect.element(ask).not.toBeInTheDocument();
      }
      await expect.element(editor).toHaveTextContent("keep going");
      await expect
        .element(page.getByRole("button", { name: "GPT-5.4", exact: true }))
        .toBeVisible();
      expect(messages()).toHaveLength(1);
    }
    await userEvent.click(editor);
    await userEvent.keyboard("{Enter}");
    const sent = { text: "keep going", instanceId: CODEX_PROVIDER.instanceId };
    await vi.waitFor(() => expect(messages()).toContainEqual(sent));
    expect(messages()).toHaveLength(withBrief ? 2 : 1);
  },
);

it("drops the compact offer on a cold Claude thread while /clear is armed", async () => {
  // At phone width, dismissing the fresh-session notice collapses the composer and hides the chip.
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const thread = coldClaudeThread("thread-claude-cleared");
  using _environment = installFakeEnvironment([thread], { providers: [CLAUDE_PROVIDER] });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 2 for ${thread.id}.`)).toBeVisible();
  const chip = page.getByRole("button", { name: "Compact 250k tokens of history before sending" });
  const compactAndSend = page.getByRole("button", { name: "Compact and send" });
  await expect.element(chip).toBeVisible();
  await expect.element(compactAndSend).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.type(editor, "/clear");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Your next message starts a fresh session")).toBeVisible();
  await expect.element(chip).not.toBeInTheDocument();
  await expect.element(compactAndSend).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Submit message" })).toBeVisible();

  await page.getByRole("button", { name: "Keep the current session" }).click();
  await expect.element(chip).toBeVisible();
  await expect.element(compactAndSend).toBeVisible();
});
