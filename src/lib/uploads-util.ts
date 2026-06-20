// lib/upload-utils.ts
import { ref, set, push, fetchCollection } from "./firebase";

export interface UploadResult {
  success: boolean;
  message: string;
  successCount: number;
  errorCount: number;
  errors?: string[];
  validationErrors?: ValidationError[];
  totalRecords?: number;
}

export interface ValidationError {
  recordIndex: number;
  field: string;
  message: string;
  value: any;
  expectedType?: string;
}

export interface FieldSchema {
  type: 'string' | 'number' | 'array' | 'date' | 'boolean' | 'object';
  required?: boolean;
  arrayType?: 'string' | 'number'; // For array fields, specify type of array elements
  minLength?: number;
  maxLength?: number;
  minValue?: number;
  maxValue?: number;
  pattern?: RegExp; // For string validation
  allowedValues?: string[]; // For enum-like validation
}

export interface CollectionSchema {
  [fieldName: string]: FieldSchema;
}

export interface UploadConfig {
  collectionName: string;
  schema: CollectionSchema;
  batchSize?: number;
  uniqueFields?: string[]; // Fields that should be unique across records
}

// Get sample data from collection to understand schema
export const getCollectionSchema = async (
  collectionName: string, 
  sampleSize: number = 5
): Promise<CollectionSchema> => {
  try {
    // Fetch first few records via Cloud Functions to understand schema
    const allRecords = await fetchCollection(collectionName);
    const docs = allRecords.slice(0, sampleSize);

    if (docs.length === 0) {
      throw new Error(`No documents found in collection "${collectionName}". Cannot determine schema.`);
    }

    const schema: CollectionSchema = {};
    
    docs.forEach((doc) => {
      for (const [field, value] of Object.entries(doc)) {
        if (field === 'id') continue; // Skip the id field added by the wrapper
        if (!schema[field]) {
          schema[field] = {
            type: getFieldType(value),
            required: value !== null && value !== undefined && value !== '',
          };

          // Add additional constraints based on field name patterns
          if (field.toLowerCase().includes('email')) {
            schema[field].pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          } else if (field.toLowerCase().includes('phone')) {
            schema[field].pattern = /^[+]?[1-9]\d{0,15}$/;
          } else if (field.toLowerCase().includes('id')) {
            schema[field].minLength = 1;
          }
        } else {
          // Update required flag - if any document has this field, it's not strictly optional
          if (value !== null && value !== undefined && value !== '') {
            schema[field].required = true;
          }
        }
      }
    });

    return schema;
  } catch (error) {
    throw new Error(`Failed to get collection schema: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

// Helper to determine field type from value
const getFieldType = (value: any): FieldSchema['type'] => {
  if (Array.isArray(value)) {
    return 'array';
  } else if (value instanceof Date) {
    return 'date';
  } else if (typeof value === 'string') {
    return 'string';
  } else if (typeof value === 'number') {
    return 'number';
  } else if (typeof value === 'boolean') {
    return 'boolean';
  } else if (typeof value === 'object' && value !== null) {
    return 'object';
  }
  return 'string'; // Default fallback
};

// File parsing utilities
export const parseCSV = (text: string): any[] => {
  const lines = text.split('\n').filter(line => line.trim());
  if (lines.length < 2) return [];
  
  const headers = lines[0].split(',').map(header => 
    header.trim().replace(/"/g, '').toLowerCase()
  );
  
  const result = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(value => 
      value.trim().replace(/"/g, '')
    );
    
    if (values.length === 1 && values[0] === '') continue;
    
    const obj: any = {};
    
    headers.forEach((header, index) => {
      obj[header] = values[index] || '';
    });
    
    result.push(obj);
  }
  
  return result;
};

export const parseJSON = (text: string): any[] => {
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [data];
  } catch (error) {
    throw new Error('Invalid JSON format');
  }
};

// Data validation against schema
const validateRecord = (
  record: any, 
  schema: CollectionSchema, 
  index: number
): ValidationError[] => {
  const errors: ValidationError[] = [];

  // Check required fields
  for (const [field, fieldSchema] of Object.entries(schema)) {
    const value = record[field];
    
    // Check if required field is missing
    if (fieldSchema.required && (value === undefined || value === null || value === '')) {
      errors.push({
        recordIndex: index,
        field,
        message: `Required field "${field}" is missing`,
        value: undefined,
        expectedType: fieldSchema.type
      });
      continue;
    }

    // Skip validation if field is optional and not provided
    if (value === undefined || value === null || value === '') {
      continue;
    }

    // Validate field type
    const typeError = validateFieldType(field, value, fieldSchema, index);
    if (typeError) {
      errors.push(typeError);
      continue;
    }

    // Validate field constraints
    const constraintErrors = validateFieldConstraints(field, value, fieldSchema, index);
    errors.push(...constraintErrors);
  }

  // Check for extra fields that don't exist in schema
  for (const field of Object.keys(record)) {
    if (!schema[field] && record[field] !== undefined && record[field] !== null && record[field] !== '') {
      errors.push({
        recordIndex: index,
        field,
        message: `Field "${field}" does not exist in database schema`,
        value: record[field]
      });
    }
  }

  return errors;
};

const validateFieldType = (
  field: string,
  value: any,
  fieldSchema: FieldSchema,
  index: number
): ValidationError | null => {
  switch (fieldSchema.type) {
    case 'string':
      if (typeof value !== 'string') {
        return {
          recordIndex: index,
          field,
          message: `Field "${field}" should be a string, got ${typeof value}`,
          value,
          expectedType: 'string'
        };
      }
      break;

    case 'number':
      if (typeof value !== 'number' || isNaN(value)) {
        // Try to convert string to number
        const numValue = typeof value === 'string' ? parseFloat(value) : Number(value);
        if (isNaN(numValue)) {
          return {
            recordIndex: index,
            field,
            message: `Field "${field}" should be a number, got "${value}"`,
            value,
            expectedType: 'number'
          };
        }
      }
      break;

    case 'array':
      if (!Array.isArray(value)) {
        // Try to parse string as array
        if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value);
            if (!Array.isArray(parsed)) {
              return {
                recordIndex: index,
                field,
                message: `Field "${field}" should be an array, got "${value}"`,
                value,
                expectedType: 'array'
              };
            }
          } catch {
            return {
              recordIndex: index,
              field,
              message: `Field "${field}" should be an array, got "${value}"`,
              value,
              expectedType: 'array'
            };
          }
        } else {
          return {
            recordIndex: index,
            field,
            message: `Field "${field}" should be an array, got ${typeof value}`,
            value,
            expectedType: 'array'
          };
        }
      }
      break;

    case 'date':
      if (!(value instanceof Date) && isNaN(new Date(value).getTime())) {
        return {
          recordIndex: index,
          field,
          message: `Field "${field}" should be a valid date, got "${value}"`,
          value,
          expectedType: 'date'
        };
      }
      break;

    case 'boolean':
      if (typeof value !== 'boolean') {
        const boolValue = String(value).toLowerCase();
        if (!['true', 'false', '1', '0', 'yes', 'no'].includes(boolValue)) {
          return {
            recordIndex: index,
            field,
            message: `Field "${field}" should be a boolean, got "${value}"`,
            value,
            expectedType: 'boolean'
          };
        }
      }
      break;
  }

  return null;
};

const validateFieldConstraints = (
  field: string,
  value: any,
  fieldSchema: FieldSchema,
  index: number
): ValidationError[] => {
  const errors: ValidationError[] = [];

  if (fieldSchema.type === 'string') {
    const stringValue = String(value);

    if (fieldSchema.minLength && stringValue.length < fieldSchema.minLength) {
      errors.push({
        recordIndex: index,
        field,
        message: `Field "${field}" should have at least ${fieldSchema.minLength} characters`,
        value,
        expectedType: `string (min ${fieldSchema.minLength} chars)`
      });
    }

    if (fieldSchema.maxLength && stringValue.length > fieldSchema.maxLength) {
      errors.push({
        recordIndex: index,
        field,
        message: `Field "${field}" should have at most ${fieldSchema.maxLength} characters`,
        value,
        expectedType: `string (max ${fieldSchema.maxLength} chars)`
      });
    }

    if (fieldSchema.pattern && !fieldSchema.pattern.test(stringValue)) {
      errors.push({
        recordIndex: index,
        field,
        message: `Field "${field}" does not match required format`,
        value,
        expectedType: `string matching pattern`
      });
    }

    if (fieldSchema.allowedValues && !fieldSchema.allowedValues.includes(stringValue)) {
      errors.push({
        recordIndex: index,
        field,
        message: `Field "${field}" should be one of: ${fieldSchema.allowedValues.join(', ')}`,
        value,
        expectedType: `one of [${fieldSchema.allowedValues.join(', ')}]`
      });
    }
  }

  if (fieldSchema.type === 'number') {
    const numValue = typeof value === 'string' ? parseFloat(value) : Number(value);

    if (fieldSchema.minValue !== undefined && numValue < fieldSchema.minValue) {
      errors.push({
        recordIndex: index,
        field,
        message: `Field "${field}" should be at least ${fieldSchema.minValue}`,
        value,
        expectedType: `number (min ${fieldSchema.minValue})`
      });
    }

    if (fieldSchema.maxValue !== undefined && numValue > fieldSchema.maxValue) {
      errors.push({
        recordIndex: index,
        field,
        message: `Field "${field}" should be at most ${fieldSchema.maxValue}`,
        value,
        expectedType: `number (max ${fieldSchema.maxValue})`
      });
    }
  }

  if (fieldSchema.type === 'array' && Array.isArray(value)) {
    if (fieldSchema.arrayType) {
      for (let i = 0; i < value.length; i++) {
        const element = value[i];
        if (fieldSchema.arrayType === 'number' && typeof element !== 'number') {
          errors.push({
            recordIndex: index,
            field: `${field}[${i}]`,
            message: `Array element should be a number, got "${element}"`,
            value: element,
            expectedType: fieldSchema.arrayType
          });
        } else if (fieldSchema.arrayType === 'string' && typeof element !== 'string') {
          errors.push({
            recordIndex: index,
            field: `${field}[${i}]`,
            message: `Array element should be a string, got "${element}"`,
            value: element,
            expectedType: fieldSchema.arrayType
          });
        }
      }
    }
  }

  return errors;
};

// Transform record to match schema types
const transformRecord = (record: any, schema: CollectionSchema): any => {
  const transformed: any = {};

  for (const [field, fieldSchema] of Object.entries(schema)) {
    const value = record[field];

    if (value === undefined || value === null || value === '') {
      if (fieldSchema.required) {
        // For required fields, set default values based on type
        switch (fieldSchema.type) {
          case 'string':
            transformed[field] = '';
            break;
          case 'number':
            transformed[field] = 0;
            break;
          case 'array':
            transformed[field] = [];
            break;
          case 'boolean':
            transformed[field] = false;
            break;
          case 'date':
            transformed[field] = new Date();
            break;
          default:
            transformed[field] = null;
        }
      }
      continue;
    }

    // Transform value to match schema type
    switch (fieldSchema.type) {
      case 'string':
        transformed[field] = String(value);
        break;

      case 'number':
        transformed[field] = typeof value === 'string' ? parseFloat(value) : Number(value);
        break;

      case 'array':
        if (typeof value === 'string') {
          try {
            transformed[field] = JSON.parse(value);
          } catch {
            // If JSON parsing fails, try comma-separated values
            transformed[field] = value.split(',').map((v: string) => v.trim());
          }
        } else {
          transformed[field] = Array.isArray(value) ? value : [value];
        }
        break;

      case 'date':
        transformed[field] = value instanceof Date ? value : new Date(value);
        break;

      case 'boolean':
        if (typeof value === 'string') {
          transformed[field] = ['true', '1', 'yes'].includes(value.toLowerCase());
        } else {
          transformed[field] = Boolean(value);
        }
        break;

      default:
        transformed[field] = value;
    }
  }

  // Add timestamps
  transformed.createdAt = new Date();
  transformed.updatedAt = new Date();

  return transformed;
};

// Main upload function with schema validation
export const uploadDataWithValidation = async (
  file: File,
  collectionName: string
): Promise<UploadResult> => {
  try {
    // Step 1: Get collection schema from database
    const schema = await getCollectionSchema(collectionName);
    
    if (Object.keys(schema).length === 0) {
      return {
        success: false,
        message: `Cannot determine schema for collection "${collectionName}". The collection might be empty.`,
        successCount: 0,
        errorCount: 0,
        errors: ['No schema found']
      };
    }

    // Step 2: Parse uploaded file
    const fileExtension = file.name.split('.').pop()?.toLowerCase();
    let parsedData: any[] = [];

    if (fileExtension === 'csv') {
      const text = await readFileAsText(file);
      parsedData = parseCSV(text);
    } else if (fileExtension === 'json') {
      const text = await readFileAsText(file);
      parsedData = parseJSON(text);
    } else {
      return {
        success: false,
        message: `Unsupported file format: ${fileExtension}. Please use CSV or JSON.`,
        successCount: 0,
        errorCount: 0,
        errors: [`Unsupported format: ${fileExtension}`]
      };
    }

    if (parsedData.length === 0) {
      return {
        success: false,
        message: 'No data found in file',
        successCount: 0,
        errorCount: 0,
        errors: ['Empty file']
      };
    }

    // Step 3: Validate all records against schema
    const validationErrors: ValidationError[] = [];
    const validRecords: any[] = [];

    parsedData.forEach((record, index) => {
      const errors = validateRecord(record, schema, index);
      
      if (errors.length === 0) {
        // Transform and add to valid records
        const transformedRecord = transformRecord(record, schema);
        validRecords.push(transformedRecord);
      } else {
        validationErrors.push(...errors);
      }
    });

    // Step 4: If there are validation errors, return them without uploading
    if (validationErrors.length > 0) {
      return {
        success: false,
        message: `Data validation failed. Please update your data to match database schema.`,
        successCount: 0,
        errorCount: parsedData.length,
        validationErrors,
        totalRecords: parsedData.length
      };
    }

    // Step 5: Upload valid records
    // NOTE: Realtime Database does not support batch writes like Firestore.
    // We simulate batches by uploading chunks in parallel using Promise.all.
    const batchSize = 500;
    let successCount = 0;

    for (let i = 0; i < validRecords.length; i += batchSize) {
      const batchRecords = validRecords.slice(i, i + batchSize);

      // Create an array of promises for this batch
      const uploadPromises = batchRecords.map(record =>
        push(collectionName, record)
      );

      // Wait for all records in this chunk to upload
      await Promise.all(uploadPromises);
      
      successCount += batchRecords.length;
    }

    return {
      success: true,
      message: `Successfully uploaded ${successCount} records that match the database schema.`,
      successCount,
      errorCount: 0,
      totalRecords: parsedData.length
    };

  } catch (error) {
    return {
      success: false,
      message: `Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      successCount: 0,
      errorCount: 0,
      errors: [`Upload error: ${error instanceof Error ? error.message : 'Unknown error'}`]
    };
  }
};

// Helper function to read file as text
const readFileAsText = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = (e) => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
};

// Utility to format validation errors for display
export const formatValidationErrors = (validationErrors: ValidationError[]): string => {
  if (!validationErrors || validationErrors.length === 0) return '';

  const errorGroups: { [key: string]: ValidationError[] } = {};
  
  validationErrors.forEach(error => {
    const key = `Record ${error.recordIndex + 1}`;
    if (!errorGroups[key]) {
      errorGroups[key] = [];
    }
    errorGroups[key].push(error);
  });

  let message = 'Validation Errors:\n\n';
  
  Object.entries(errorGroups).forEach(([recordKey, errors]) => {
    message += `${recordKey}:\n`;
    errors.forEach(error => {
      message += `  • ${error.field}: ${error.message}`;
      if (error.value !== undefined) {
        message += ` (value: "${error.value}")`;
      }
      if (error.expectedType) {
        message += ` [Expected: ${error.expectedType}]`;
      }
      message += '\n';
    });
    message += '\n';
  });

  return message;
};
