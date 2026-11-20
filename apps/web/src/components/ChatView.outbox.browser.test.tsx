import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes several seconds;
// importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { threadOutboxStore } from "~/threadOutboxDelivery";
import {
  ENVIRONMENT_ID,
  disconnectFakeEnvironment,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// Its own file: the app's registry outlives each test, and an earlier test's cached
// shell would replace this thread's once the environment disconnects.
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

it("shows a message sent while disconnected in the thread until it is edited back", async () => {
  const thread = threadWithHistory("outbox-waiting", 1);
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const threadRef = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

  await act(() => disconnectFakeEnvironment());
  const send = page.getByRole("button", { name: /^Send when .+ connects$/ });
  await act(() => useComposerDraftStore.getState().setPrompt(threadRef, "Wait for the link"));
  await send.click();

  // The message leaves the composer and waits, visibly, at the end of the thread.
  await expect.element(page.getByText("Wait for the link")).toBeVisible();
  await expect.element(page.getByText(/^Sends when .+ connects$/)).toBeVisible();
  expect(threadOutboxStore.getState().messages.map((message) => message.draftText)).toEqual([
    "Wait for the link",
  ]);

  await page.getByRole("button", { name: "Edit waiting message" }).click();
  await expect.element(page.getByText(/^Sends when .+ connects$/)).not.toBeInTheDocument();
  expect(threadOutboxStore.getState().messages).toEqual([]);
  expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
    "Wait for the link",
  );
});
