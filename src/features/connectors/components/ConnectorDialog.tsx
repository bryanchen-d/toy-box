import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { cn } from "@/shared/utils";
import {
  connectorHandle,
  connectorOptionsSchema,
  type Connector,
  type ConnectorOptions,
  type ConnectorTransport,
  type PoolNode,
} from "../model";
import { connectorMutations } from "../mutations";
import { connectorQueries } from "../queries";

const KINDS: { kind: ConnectorOptions["kind"]; label: string }[] = [
  { kind: "service", label: "Service" },
  { kind: "agentPool", label: "Agent pool" },
];

const TRANSPORTS: { type: ConnectorTransport["type"]; label: string }[] = [
  { type: "http", label: "URL" },
  { type: "devtunnel", label: "Dev tunnel" },
];

/** What the transport fields hold while they're edited. */
type TransportDraft = {
  type: ConnectorTransport["type"];
  url: string;
  tunnelId: string;
  port: string;
};

/** What a pool node's fields hold while they're edited. */
type NodeDraft = {
  key: string;
  name: string;
  transport: TransportDraft;
  tokenFile: string;
  workspaces: string;
  scratchFolder: string;
  computeSlots: string;
  draining: boolean;
};

export function ConnectorDialog({
  connector,
  onOpenChange,
}: {
  connector?: Connector;
  onOpenChange: (open: boolean) => void;
}) {
  const saveMutation = useMutation(
    connector ? connectorMutations.update(connector.id) : connectorMutations.create(),
  );
  const [name, setName] = useState(connector?.name ?? "");
  const [kind, setKind] = useState<ConnectorOptions["kind"]>(connector?.kind ?? "service");
  const [transport, setTransport] = useState(() =>
    transportDraft(connector?.kind === "service" ? connector.transport : undefined, {
      type: "http",
      port: "4243",
    }),
  );
  const [nodes, setNodes] = useState<NodeDraft[]>(() =>
    connector?.kind === "agentPool" ? connector.nodes.map(nodeDraft) : [nodeDraft()],
  );
  const options = connectorOptionsSchema.safeParse(
    kind === "service"
      ? { name, kind, transport: transportFrom(transport) }
      : { name, kind, nodes: nodes.map(nodeFrom) },
  );
  const handle = name.trim() ? ` as @${connectorHandle({ name })}` : "";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!options.success) return;
    saveMutation.mutate(options.data, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(kind === "agentPool" && "max-h-[90vh] overflow-y-auto sm:max-w-xl")}
      >
        <form className="space-y-4" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{connector ? "Edit connector" : "Add connector"}</DialogTitle>
            <DialogDescription>
              {kind === "service"
                ? `Every team can talk to a connector by mentioning it${handle}. Agent Teams always dials the connector, so only the connector needs to be reachable.`
                : `Team agents mention the pool${handle} to run work in remote sessions on its nodes' VS Code agent hosts. Agent Teams dials each node and stores no secrets.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Name">
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={kind === "service" ? "BryanBot" : "Pool"}
                />
              )}
            </Field>
            <Choice
              label="Kind"
              options={KINDS.map(({ kind: value, label }) => ({ value, label }))}
              value={kind}
              onChange={setKind}
            />
            {kind === "service" ? (
              <TransportFields value={transport} onChange={setTransport} />
            ) : (
              <div className="space-y-3">
                {nodes.map((node, index) => (
                  <PoolNodeFields
                    key={node.key}
                    node={node}
                    onChange={(next) =>
                      setNodes(nodes.map((each, at) => (at === index ? next : each)))
                    }
                    onRemove={
                      nodes.length > 1
                        ? () => setNodes(nodes.filter((_, at) => at !== index))
                        : undefined
                    }
                  />
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setNodes([...nodes, nodeDraft()])}
                >
                  <Plus className="mr-1 size-3.5" /> Add node
                </Button>
                {!options.success && (
                  <p className="text-xs text-muted-foreground">
                    Each node needs its own name, an address, a host token file, a scratch folder,
                    and workspaces written as owner/name = folder.
                  </p>
                )}
              </div>
            )}
          </div>
          {saveMutation.error && (
            <p className="text-sm text-destructive">{saveMutation.error.message}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={saveMutation.isPending || !options.success}>
              {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {connector ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One node of a pool: how to reach its agent host, and where its sessions start. */
function PoolNodeFields({
  node,
  onChange,
  onRemove,
}: {
  node: NodeDraft;
  onChange: (node: NodeDraft) => void;
  onRemove?: () => void;
}) {
  const drainingId = useId();
  return (
    <fieldset className="space-y-3 rounded-md border border-border/70 p-3">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="Node">
            {(id) => (
              <Input
                id={id}
                value={node.name}
                onChange={(event) => onChange({ ...node, name: event.target.value })}
                placeholder="brchen-db3"
              />
            )}
          </Field>
        </div>
        {onRemove && (
          <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      <TransportFields
        value={node.transport}
        onChange={(transport) => onChange({ ...node, transport })}
      />
      <Field label="Host token file">
        {(id) => (
          <Input
            id={id}
            value={node.tokenFile}
            onChange={(event) => onChange({ ...node, tokenFile: event.target.value })}
            placeholder="Q:\agent-teams\pool\brchen-db3.token"
          />
        )}
      </Field>
      <Field label="Workspaces">
        {(id) => (
          <Textarea
            id={id}
            rows={2}
            value={node.workspaces}
            onChange={(event) => onChange({ ...node, workspaces: event.target.value })}
            placeholder="bryanchen-d/vscode-space = C:\Users\you\repos\vscode-space"
          />
        )}
      </Field>
      <p className="text-xs text-muted-foreground">
        One repository per line, as owner/name = its folder on the node. Sessions for a team working
        in one of them start there; others start in the scratch folder.
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
        <Field label="Scratch folder">
          {(id) => (
            <Input
              id={id}
              value={node.scratchFolder}
              onChange={(event) => onChange({ ...node, scratchFolder: event.target.value })}
              placeholder="C:\Users\you\.agent-node\scratch"
            />
          )}
        </Field>
        <Field label="Compute slots">
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              value={node.computeSlots}
              onChange={(event) => onChange({ ...node, computeSlots: event.target.value })}
            />
          )}
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={drainingId}
          checked={node.draining}
          onCheckedChange={(checked) => onChange({ ...node, draining: checked })}
        />
        <label htmlFor={drainingId} className="text-sm">
          Draining: finish its sessions, but take no new ones
        </label>
      </div>
    </fieldset>
  );
}

function TransportFields({
  value,
  onChange,
}: {
  value: TransportDraft;
  onChange: (value: TransportDraft) => void;
}) {
  return (
    <>
      <Choice
        label="Connect with"
        options={TRANSPORTS.map(({ type, label }) => ({ value: type, label }))}
        value={value.type}
        onChange={(type) => onChange({ ...value, type })}
      />
      {value.type === "http" ? (
        <Field label="URL">
          {(id) => (
            <Input
              id={id}
              value={value.url}
              onChange={(event) => onChange({ ...value, url: event.target.value })}
              placeholder="http://127.0.0.1:4243"
            />
          )}
        </Field>
      ) : (
        <DevTunnelFields
          tunnelId={value.tunnelId}
          port={value.port}
          onChange={(next) => onChange({ ...value, ...next })}
        />
      )}
    </>
  );
}

function Choice<Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{label}</p>
      <div className="inline-flex rounded-md border border-border/70 p-0.5" role="radiogroup">
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant={value === option.value ? "secondary" : "ghost"}
            role="radio"
            aria-checked={value === option.value}
            className="h-7 px-3"
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function transportDraft(
  transport: ConnectorTransport | undefined,
  defaults: { type: ConnectorTransport["type"]; port: string },
): TransportDraft {
  return {
    type: transport?.type ?? defaults.type,
    url: transport?.type === "http" ? transport.url : `http://127.0.0.1:${defaults.port}`,
    tunnelId: transport?.type === "devtunnel" ? transport.tunnelId : "",
    port: transport?.type === "devtunnel" ? String(transport.port) : defaults.port,
  };
}

function transportFrom(draft: TransportDraft) {
  return draft.type === "http"
    ? { type: draft.type, url: draft.url.trim() }
    : { type: draft.type, tunnelId: draft.tunnelId, port: Number(draft.port) };
}

/** A node's fields, defaulting to the agent node kit's port and to no compute limit. */
function nodeDraft(node?: PoolNode): NodeDraft {
  return {
    key: crypto.randomUUID(),
    name: node?.name ?? "",
    transport: transportDraft(node?.transport, { type: "devtunnel", port: "31790" }),
    tokenFile: node?.tokenFile ?? "",
    workspaces: (node?.workspaces ?? [])
      .map(({ repository, folder }) => `${repository} = ${folder}`)
      .join("\n"),
    scratchFolder: node?.scratchFolder ?? "",
    computeSlots: String(node?.computeSlots ?? 9_999),
    draining: node?.draining ?? false,
  };
}

function nodeFrom(draft: NodeDraft) {
  return {
    name: draft.name,
    transport: transportFrom(draft.transport),
    tokenFile: draft.tokenFile,
    workspaces: draft.workspaces
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const [repository = "", ...folder] = line.split("=");
        return { repository: repository.trim(), folder: folder.join("=").trim() };
      }),
    scratchFolder: draft.scratchFolder,
    computeSlots: Number(draft.computeSlots),
    draining: draft.draining,
  };
}

/** Offers the logged-in account's tunnels, and still accepts any tunnel by hand. */
function DevTunnelFields({
  tunnelId,
  port,
  onChange,
}: {
  tunnelId: string;
  port: string;
  onChange: (value: { tunnelId: string; port: string }) => void;
}) {
  const tunnels = useQuery(connectorQueries.tunnels());

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">Your dev tunnels</p>
        {tunnels.isPending ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Looking for your dev tunnels...
          </p>
        ) : tunnels.error ? (
          <p className="text-xs text-muted-foreground">
            Couldn't list your dev tunnels: {tunnels.error.message} Enter the tunnel below.
          </p>
        ) : tunnels.data.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Your devtunnel account has no tunnels yet. Create one where the connector runs, or enter
            it below.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tunnels.data.flatMap((tunnel) =>
              (tunnel.ports.length ? tunnel.ports : [Number(port) || 4243]).map((tunnelPort) => {
                const selected = tunnel.tunnelId === tunnelId && String(tunnelPort) === port;
                return (
                  <Button
                    key={`${tunnel.tunnelId}:${tunnelPort}`}
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-pressed={selected}
                    title={tunnel.hosted ? "Hosted now" : "Not hosted right now"}
                    className={cn("h-7 gap-1.5 font-mono text-xs", selected && "ring-2 ring-ring")}
                    onClick={() =>
                      onChange({ tunnelId: tunnel.tunnelId, port: String(tunnelPort) })
                    }
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 rounded-full",
                        tunnel.hosted ? "bg-green-500" : "bg-muted-foreground/40",
                      )}
                    />
                    {tunnel.tunnelId}:{tunnelPort}
                  </Button>
                );
              }),
            )}
          </div>
        )}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
        <Field label="Tunnel ID">
          {(id) => (
            <Input
              id={id}
              value={tunnelId}
              onChange={(event) => onChange({ tunnelId: event.target.value, port })}
              placeholder="bryanbot.usw2"
            />
          )}
        </Field>
        <Field label="Port">
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              value={port}
              onChange={(event) => onChange({ tunnelId, port: event.target.value })}
            />
          )}
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        Agent Teams reaches the tunnel with tokens from your devtunnel login, so this machine needs
        the devtunnel CLI signed in to the account that owns the tunnel. A Microsoft account renews
        itself; a GitHub account needs signing in again every few days.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {children(id)}
    </div>
  );
}
