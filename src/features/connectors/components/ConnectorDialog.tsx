import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { cn } from "@/shared/utils";
import {
  connectorHandle,
  connectorOptionsSchema,
  type Connector,
  type ConnectorTransport,
} from "../model";
import { connectorMutations } from "../mutations";
import { connectorQueries } from "../queries";

const TRANSPORTS: { type: ConnectorTransport["type"]; label: string }[] = [
  { type: "http", label: "URL" },
  { type: "devtunnel", label: "Dev tunnel" },
];

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
  const transport = connector?.transport;
  const [name, setName] = useState(connector?.name ?? "");
  const [type, setType] = useState<ConnectorTransport["type"]>(transport?.type ?? "http");
  const [url, setUrl] = useState(
    transport?.type === "http" ? transport.url : "http://127.0.0.1:4243",
  );
  const [tunnelId, setTunnelId] = useState(
    transport?.type === "devtunnel" ? transport.tunnelId : "",
  );
  const [port, setPort] = useState(
    transport?.type === "devtunnel" ? String(transport.port) : "4243",
  );
  const options = connectorOptionsSchema.safeParse({
    name,
    transport: type === "http" ? { type, url: url.trim() } : { type, tunnelId, port: Number(port) },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!options.success) return;
    saveMutation.mutate(options.data, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{connector ? "Edit connector" : "Add connector"}</DialogTitle>
            <DialogDescription>
              Every team can talk to a connector by mentioning it
              {name.trim() ? ` as @${connectorHandle({ name })}` : ""}. Agent Teams always dials the
              connector, so only the connector needs to be reachable.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Name">
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="BryanBot"
                />
              )}
            </Field>
            <div className="space-y-1">
              <p className="text-sm font-medium">Connect with</p>
              <div
                className="inline-flex rounded-md border border-border/70 p-0.5"
                role="radiogroup"
              >
                {TRANSPORTS.map((option) => (
                  <Button
                    key={option.type}
                    type="button"
                    size="sm"
                    variant={type === option.type ? "secondary" : "ghost"}
                    role="radio"
                    aria-checked={type === option.type}
                    className="h-7 px-3"
                    onClick={() => setType(option.type)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
            {type === "http" ? (
              <Field label="URL">
                {(id) => (
                  <Input
                    id={id}
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="http://127.0.0.1:4243"
                  />
                )}
              </Field>
            ) : (
              <DevTunnelFields
                tunnelId={tunnelId}
                port={port}
                onChange={(next) => {
                  setTunnelId(next.tunnelId);
                  setPort(next.port);
                }}
              />
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
