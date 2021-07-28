import { FunctionComponent } from "react";
import { BehaviorSubject } from "rxjs";

export interface ColumnType {
  name: string;
  // metadata: Record<string, any> // Could maybe pass in metadata to parsers (ex Date format, specific currency)
}

export interface Column {
  Header: string;
  accessor: string;
  Type: ColumnType;
}

export interface RowValue {
  readValue: string; // Formatted value
  readError: Error;
  writeValue: string; // What I edit in (parsed as read and to underlying value)
  underlyingValue: any; // Ex JS Date
  underlyingError: Error;
}

export interface Table {
  rows: Record<string, RowValue>[];
  columns: Column[];
}

export interface NodeIO {
  sources: Record<string, BehaviorSubject<any>>;
  sinks: Record<string, BehaviorSubject<any>>;
}

export interface GraphNode<T extends NodeIO> {
  initializeStreams({ initialData }: { initialData: any }): T;
  persist?: boolean;
  beforeStore?: (inputs: any) => any;
  Component: FunctionComponent<{ data: T }>;
}

export interface OmnibarItem {
  type: string;
  label: string;
  data: any;
}
