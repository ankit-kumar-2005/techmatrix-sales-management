"use client";

import { useState } from "react";
import { AddTaskDialog } from "./add-task-dialog";
import { TaskList } from "./task-list";
import { PlusIcon } from "@/features/sales-management/components/icons";
import type { TaskDueBucket, TasksBucketPage } from "../lib/get-tasks";
import type { TeamDirectoryEntry } from "@/types/lead";

type TasksPageClientProps = {
  initialBuckets: Partial<Record<TaskDueBucket, TasksBucketPage>>;
  initialTodayStr: string;
  initialSearch: string;
  initialOwnerId: string;
  initialType: string;
  initialPriority: string;
  initialStatus: string;
  initialDueBucket: TaskDueBucket | "";
  assignableUsers: TeamDirectoryEntry[];
  currentUserCustomerUserId: string;
};

/**
 * The single client boundary the Tasks page needs, owning exactly one
 * piece of shared state (`refreshToken`) — the "+ Add task" button lives
 * in the page HEADER (top-right, next to the heading, matching where
 * Contacts' "+ New contact" already lives — ContactsPageClient) while the
 * list it needs to refresh (TaskList) is a sibling further down the page;
 * lifting just this one token to their nearest common ancestor is the
 * same pattern ContactsPageClient already uses.
 *
 * TaskList is ALWAYS mounted here — there is deliberately no "No tasks
 * yet" top-level empty state gating it (unlike this page's previous
 * version). Each due-date bucket already renders its own accurate empty
 * message when it has nothing (see task-list.tsx's bucketEmptyMessage),
 * matching how ContactList has no top-level empty gate either. This
 * isn't just for consistency: gating TaskList's mount behind a
 * "hasAnyTasksAtAll" flag would reintroduce the exact class of bug this
 * app already got burned by once this session (see task-list.tsx's own
 * long comment on the "Completed doesn't show until refresh" race) —
 * the "+ Add task" button here is unconditionally visible, so a customer
 * with zero tasks creating their very first one from this exact header
 * button would bump refreshToken BEFORE TaskList ever mounted, and each
 * TaskGroupSection's own "skip the first fetch, trust the server's seed
 * data" optimization has no way to know the seed data it was handed is
 * now stale relative to that nonzero refreshToken. Mounting TaskList
 * unconditionally, from the very first render (refreshToken always 0 at
 * that point), keeps that optimization's own assumption — "nothing has
 * changed yet" — actually true.
 */
export function TasksPageClient({
  initialBuckets,
  initialTodayStr,
  initialSearch,
  initialOwnerId,
  initialType,
  initialPriority,
  initialStatus,
  initialDueBucket,
  assignableUsers,
  currentUserCustomerUserId,
}: TasksPageClientProps) {
  const [refreshToken, setRefreshToken] = useState(0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">Tasks &amp; Reminders</h1>
          <span
            aria-hidden="true"
            className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600"
          />
          <p className="mt-1.5 text-sm text-neutral-500">
            Everything due across your leads, grouped by when it&rsquo;s due.
          </p>
        </div>

        <AddTaskDialog
          assignableUsers={assignableUsers}
          currentUserCustomerUserId={currentUserCustomerUserId}
          onSuccess={() => setRefreshToken((token) => token + 1)}
          renderTrigger={(open) => (
            <button
              type="button"
              onClick={open}
              className="flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 hover:shadow-md focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none sm:w-auto"
            >
              <PlusIcon className="h-4 w-4 shrink-0" />
              Add Task
            </button>
          )}
        />
      </div>

      <TaskList
        initialBuckets={initialBuckets}
        initialTodayStr={initialTodayStr}
        initialSearch={initialSearch}
        initialOwnerId={initialOwnerId}
        initialType={initialType}
        initialPriority={initialPriority}
        initialStatus={initialStatus}
        initialDueBucket={initialDueBucket}
        assignableUsers={assignableUsers}
        currentUserCustomerUserId={currentUserCustomerUserId}
        refreshToken={refreshToken}
        onRefreshAll={() => setRefreshToken((token) => token + 1)}
      />
    </div>
  );
}
