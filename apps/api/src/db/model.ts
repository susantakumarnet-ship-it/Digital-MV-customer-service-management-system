import mongoose, { type Schema } from 'mongoose';

/**
 * Registers a model, replacing any previous registration of the same name. Test runners may
 * re-evaluate model modules while the mongoose singleton persists; this avoids OverwriteModelError
 * while keeping full type inference from the schema.
 */
export function defineModel<TSchema extends Schema>(name: string, schema: TSchema) {
  if (mongoose.models[name]) mongoose.deleteModel(name);
  return mongoose.model(name, schema);
}
