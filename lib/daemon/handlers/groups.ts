/**
 * Exclusive-group IPC handlers. A group ensures that at most one member process
 * is "active" at a time; the others are suspended (warm) or killed (single).
 *
 *   group:create          group:remove
 *   group:add             group:remove-member
 *   group:activate
 *   group:list            group:get
 */

import type { HandlerContext, HandlerMap } from "./types.ts";

export function createGroupsHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "group:create": async (payload) => {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      ctx.exclusiveGroup.create(id);
      return { ok: true };
    },

    "group:remove": async (payload) => {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      ctx.exclusiveGroup.remove(id);
      return { ok: true };
    },

    "group:add": async (payload) => {
      const { groupId, processId } = payload as { groupId: string; processId: string };
      if (!groupId || !processId) return { ok: false, error: "missing groupId or processId" };
      ctx.exclusiveGroup.addMember(groupId, processId);
      return { ok: true };
    },

    "group:remove-member": async (payload) => {
      const { groupId, processId } = payload as { groupId: string; processId: string };
      if (!groupId || !processId) return { ok: false, error: "missing groupId or processId" };
      ctx.exclusiveGroup.removeMember(groupId, processId);
      return { ok: true };
    },

    "group:activate": async (payload) => {
      const { groupId, processId, mode } = payload as { groupId: string; processId: string; mode?: "warm" | "single" };
      if (!groupId || !processId) return { ok: false, error: "missing groupId or processId" };
      await ctx.exclusiveGroup.activate(groupId, processId, mode ?? "warm");
      return { ok: true };
    },

    "group:list": async () => {
      return { ok: true, data: ctx.exclusiveGroup.list() };
    },

    "group:get": async (payload) => {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      return { ok: true, data: ctx.exclusiveGroup.get(id) };
    },
  };
}
