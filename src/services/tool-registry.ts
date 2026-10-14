import { isServicePermissionEnabled, type ServicePermission, type ServiceSettings } from "./settings.ts";

// Shared by discovery, status and dispatch. Unknown names never inherit access.
export const TOOL_PERMISSIONS: Readonly<Record<string, ServicePermission>> = Object.freeze({
  ...Object.fromEntries([
    "get_reminder_view", "export_reminders", "get_reminder_filters", "run_reminder_filter", "inspect_reminder", "get_reminder_list_sections",
    "get_reminder_lists", "get_reminders", "search_reminders", "get_reminder", "get_reminder_organization",
    "get_all_open_reminders", "get_reminder_list", "get_reminder_list_appearance", "get_shopping_categories",
    "prepare_reminder_update", "get_reminder_job", "preview_reminder_job",
  ].map(name => [name, "reminders.read" as const])),
  ...Object.fromEntries([
    "save_reminder_filter", "delete_reminder_filter", "create_reminder_workflow", "duplicate_reminder_list",
    "set_reminder_url", "set_reminder_tags", "move_reminder", "copy_reminder", "create_reminder", "create_subtask",
    "set_reminder_parent", "update_reminder_list_appearance", "set_reminder_category", "create_reminder_list",
    "rename_reminder_list", "delete_reminder_list", "update_reminder", "complete_reminder", "reopen_reminder", "delete_reminder",
    "create_reminder_job", "append_reminder_job_items", "start_reminder_job", "cancel_reminder_job", "resume_reminder_job", "continue_reminder_job",
  ].map(name => [name, "reminders.write" as const])),
  list_icloud_drive_items: "drive.browse", get_icloud_drive_item: "drive.browse", search_icloud_drive: "drive.browse", traverse_icloud_drive: "drive.browse",
  resolve_icloud_drive_folder_path: "drive.browse",
  read_icloud_drive_file: "drive.contents", download_icloud_drive_file: "drive.contents",
  upload_icloud_drive_file: "drive.upload", create_icloud_drive_folder: "drive.organize",
  rename_icloud_drive_item: "drive.organize", move_icloud_drive_item: "drive.organize", get_icloud_drive_operation: "drive.browse",
});
export function enabledToolNames(settings: ServiceSettings): string[] {
  return ["connection_status", ...Object.entries(TOOL_PERMISSIONS).filter(([, permission]) => isServicePermissionEnabled(settings, permission)).map(([name]) => name)];
}
