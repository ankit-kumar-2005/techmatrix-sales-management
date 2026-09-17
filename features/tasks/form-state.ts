export type TaskFormState = {
  fieldErrors?: Record<string, string>;
  formError?: string;
  success?: boolean;
  /** The id of the task createTaskAction just inserted.
   *
   *  ADDED FOR MEETING NOTES, and additive on purpose: a caller that
   *  ignores it (the Tasks page, Edit Lead, the Pipeline board) is
   *  unaffected. Meeting Notes needs it because turning an action item
   *  into a task is two facts — the task exists, and THIS item produced
   *  it — and the second cannot be recorded without knowing which task.
   *
   *  Only ever set on a successful create. updateTaskAction does not set
   *  it: nothing needs the id of a task that already existed. */
  taskId?: string;
};

export const initialTaskFormState: TaskFormState = {};
