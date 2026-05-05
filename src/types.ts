export enum OperationStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  ERROR = 'error',
}

export interface Teacher {
  id: string;
  name: string;
  foldersCount: number;
  lastUpdated: string;
}

export interface FileState {
  id: string;
  file: File;
  preview: string;
  status: OperationStatus;
  tags?: { categoryId: number; subCategoryName: string }[];
  base64?: string;
  suggestedTitle?: string;
  errorMessage?: string;
}
