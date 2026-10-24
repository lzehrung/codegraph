export interface RecordOptions { enabled: boolean } // @def RecordOptions @coverage RecordOptions complete
export function makeRecord() { return { label: "fresh", enabled: true }; } // @def makeRecord @coverage makeRecord complete
export function updateRecord(record: { label: string }) { return { ...record, label: record.label.trim() }; } // @def updateRecord @coverage updateRecord complete
