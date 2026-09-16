import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStateDir, readJsonIfExists, withFileLock, writeSecureJson } from "../config/paths.js";
import { resolveMachineIdentity } from "./identity.js";

/**
 * Which ChatGPT app on this device reaches this machine's gateway.
 *
 * This used to record the tunnel id and association id because one ChatGPT
 * account could hold several devices' tunnel-backed connectors. With a public
 * HTTP endpoint the device is identified by its machine id and the app's own
 * stable URL, so those tunnel fields are gone.
 */

const nameSchema = z.string().min(1).max(200).refine(
  (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
);
const pluginUrlSchema = z.string().regex(/^https:\/\/chatgpt\.com\/plugins\/plugin_[A-Za-z0-9_-]+$/).refine(value => value.trim() === value);
const bindingSchema = z.object({
  schemaVersion: z.literal(2),
  machineId: z.string().regex(/^machine-[a-f0-9]{32}$/),
  name: nameSchema,
  pluginUrl: pluginUrlSchema.optional(),
  updatedAt: z.string().datetime(),
}).strict();

export type MachineConnectorBinding = z.infer<typeof bindingSchema>;
export type ConnectorTarget = Omit<MachineConnectorBinding, "schemaVersion" | "updatedAt">;
export type ConnectorMachine = Pick<ConnectorTarget, "machineId">;
export type ConnectorBindingStatus = {
  status: "unconfigured" | "bound" | "stale";
  binding: MachineConnectorBinding | null;
};

export function machineConnectorFile(): string {
  return path.join(getStateDir(), "machine", "connector.json");
}

function readBinding(): MachineConnectorBinding | null {
  const file = machineConnectorFile();
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Machine connector binding must be a regular file");
  const parsed = bindingSchema.safeParse(readJsonIfExists<unknown>(file));
  if (!parsed.success) return null;
  return parsed.data;
}

export function connectorMachine(): ConnectorMachine {
  return { machineId: resolveMachineIdentity().machineId };
}

export function machineConnectorStatus(machine: ConnectorMachine = connectorMachine()): ConnectorBindingStatus {
  const binding = readBinding();
  if (!binding) return { status: "unconfigured", binding: null };
  return { status: binding.machineId === machine.machineId ? "bound" : "stale", binding };
}

export function requireMachineConnector(machine: ConnectorMachine = connectorMachine()): ConnectorTarget {
  const result = machineConnectorStatus(machine);
  if (result.status !== "bound" || !result.binding) {
    throw new Error(
      `Machine connector binding is ${result.status}; bind this device's exact ChatGPT app once with ` +
        `c2c machine connector set --name <exact-name> [--plugin-url <observed-url>]. Do not select another device's app.`
    );
  }
  const { schemaVersion: _version, updatedAt: _time, ...target } = result.binding;
  return target;
}

/** Local routing configuration, not proof of the remote app's reachability. */
export function bindMachineConnector(
  machine: ConnectorMachine,
  input: { name: string; pluginUrl?: string }
): MachineConnectorBinding {
  const file = machineConnectorFile();
  return withFileLock(path.join(path.dirname(file), "connector.lock"), () => {
    const previous = readBinding();
    const sameMachine = previous !== null && previous.machineId === machine.machineId;
    const binding = bindingSchema.parse({
      schemaVersion: 2,
      ...machine,
      name: input.name,
      pluginUrl: input.pluginUrl ?? (sameMachine ? previous.pluginUrl : undefined),
      updatedAt: new Date().toISOString(),
    });
    writeSecureJson(file, binding);
    return binding;
  });
}
