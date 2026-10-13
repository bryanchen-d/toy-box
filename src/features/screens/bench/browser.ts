import { $ } from "bun";
import { strict as assert } from "node:assert";
import { SCREEN_CAPTURE } from "../server/helper";
import { screenRuntime, type ScreenPeer } from "../server/runtime";
import { decodeScreenPacket, type ScreenServerMessage } from "../model/protocol";
import type { ScreenFrame } from "../model";

const output = process.argv[2] ?? "test-results/screen-browser.json";
const session = `screen-bench-${process.pid}`;
const title = `Toy Box Screen Benchmark ${process.pid}`;
const motionByteBudget = 1_280_000;
const timers = new Set<ReturnType<typeof setTimeout>>();
const errors: string[] = [];
let screenId = "";
let latest: ScreenFrame;
let changed: (() => void) | undefined;
const count = () => ({ frames: 0, bytes: 0, regions: 0 });
const fast = { value: count() },
  remote = { value: count() };
function peer(id: string, counter: typeof fast, delay: number): ScreenPeer {
  return {
    id,
    close() {},
    send(data) {
      if (typeof data === "string") {
        const message = JSON.parse(data) as ScreenServerMessage;
        if (message.type === "state" && message.status === "ended")
          errors.push(message.reason ?? "Screen ended.");
        return;
      }
      const frame = decodeScreenPacket(data).metadata as ScreenFrame;
      counter.value.frames++;
      counter.value.bytes += data.byteLength;
      if (frame.region) counter.value.regions++;
      if (id === "fast") {
        latest = frame;
        changed?.();
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        screenRuntime.acknowledge(screenId, id, frame.sequence);
      }, delay);
      timers.add(timer);
    },
  };
}
async function playwright(args: string[]) {
  const stdout = await $`playwright-cli --session ${session} --raw ${args}`.quiet().text();
  if (/^### Error/m.test(stdout)) throw new Error(stdout);
  return stdout;
}
async function evaluate<T>(code: string): Promise<T> {
  return JSON.parse(await playwright(["run-code", code]));
}
async function phase(mode: string, seconds: number) {
  await evaluate(
    `async page=>page.evaluate(mode=>{window.screenBenchmark.mode=mode;return true;},${JSON.stringify(mode)})`,
  );
  await Bun.sleep(750);
  fast.value = count();
  remote.value = count();
  const start = performance.now();
  await Bun.sleep(seconds * 1000);
  const duration = (performance.now() - start) / 1000;
  const metrics = ({ value }: typeof fast) => ({
    ...value,
    fps: value.frames / duration,
    averageFrameBytes: value.bytes / Math.max(1, value.frames),
    megabitsPerSecond: (value.bytes * 8) / duration / 1_000_000,
  });
  return { seconds: duration, fast: metrics(fast), remote: metrics(remote) };
}
try {
  await playwright([
    "--headed",
    "--config",
    Bun.fileURLToPath(new URL("./browser.json", import.meta.url)),
    "open",
    "about:blank",
  ]);
  await evaluate(
    `async page=>{await page.setContent(${JSON.stringify(await Bun.file(new URL("./scene.html", import.meta.url)).text())});await page.evaluate(title=>document.title=title,${JSON.stringify(title)});return true;}`,
  );
  await playwright(["snapshot"]);
  const source = await evaluate<
    Record<"x" | "y" | "width" | "height" | "scale", number>
  >(`async page=>{
    await page.locator("canvas").click();
    const button=await page.locator("#increment").boundingBox();
    const v=await page.evaluate(()=>({innerHeight,outerHeight,outerWidth,devicePixelRatio}));
    if(v.outerWidth!==1280||v.outerHeight!==800||v.devicePixelRatio!==2)
      throw new Error("Benchmark requires a native 1280x800 window at 2x: "+JSON.stringify(v));
    return {width:v.outerWidth,height:v.outerHeight,scale:v.devicePixelRatio,
      x:(button.x+button.width/2)/v.outerWidth,y:(button.y+button.height/2+v.outerHeight-v.innerHeight)/v.outerHeight};
  }`);
  const screen = (await screenRuntime.list()).windows.find((window) => window.title === title);
  if (!screen) throw new Error("Benchmark window was not listed.");
  screenId = screen.id;
  screenRuntime.attach(screenId, peer("fast", fast, 0));
  screenRuntime.attach(screenId, peer("remote", remote, 50));
  for (let attempt = 0; !latest! && attempt < 100; attempt++) await Bun.sleep(100);
  if (!latest!)
    throw new Error("No native frame arrived; unlock the host and check capture permissions.");
  assert.deepEqual([latest.width, latest.height], [2560, 1600]);
  const idle = await phase("static", 5);
  await screenRuntime.takeControl(screenId, "fast");
  await Bun.sleep(500);
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const next = Promise.withResolvers<void>();
    changed = next.resolve;
    const timer = setTimeout(() => next.reject(new Error("Native click produced no frame.")), 2000);
    const start = performance.now();
    try {
      await screenRuntime.input(screenId, "fast", [
        { type: "pointer", x: source.x, y: source.y, phase: "down", button: 0 },
        { type: "pointer", x: source.x, y: source.y, phase: "up", button: 0 },
      ]);
      await next.promise;
      samples.push(performance.now() - start);
    } finally {
      clearTimeout(timer);
      changed = undefined;
    }
    await Bun.sleep(80);
  }
  const clicks = await evaluate<number>(
    "async page=>page.evaluate(()=>window.screenBenchmark.clicks)",
  );
  await screenRuntime.releaseControl(screenId, "fast");
  const motion = await phase("motion", 10);
  const spinner = await phase("spinner", 5);
  const p95Ms = [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!;
  const report = {
    capture: SCREEN_CAPTURE,
    frame: { width: latest.width, height: latest.height },
    source,
    motionByteBudget,
    idle,
    input: { clicks, samples, p95Ms },
    motion,
    spinner,
    errors,
  };
  await Bun.write(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(
    errors.length + idle.fast.frames + idle.remote.frames,
    0,
    "Capture failed or static frames were sent.",
  );
  assert(clicks === 10 && p95Ms <= 250, "Human click-to-frame exceeded its contract.");
  assert.equal(motion.fast.regions, 0, "Motion must exercise full frames.");
  assert(
    motion.fast.fps >= 27 && motion.fast.averageFrameBytes <= motionByteBudget,
    "Motion missed its FPS/byte budget.",
  );
  assert(motion.remote.fps >= 25, "The 50 ms ACK viewer missed 25 fps.");
  assert(
    spinner.fast.fps >= 27 && spinner.fast.averageFrameBytes <= 10_000,
    "The 32px spinner missed its delivery/byte budget.",
  );
} finally {
  for (const timer of timers) clearTimeout(timer);
  await screenRuntime.close();
  await playwright(["close"]);
}
