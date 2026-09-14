import { isRecord } from '../shared/utils'

export function formCanStorePreference(field: { type?: unknown, options?: unknown }, value: unknown): boolean {
  if (value === undefined)
    return true
  if (field.type === 'switch')
    return typeof value === 'boolean'
  if (field.type === 'number')
    return typeof value === 'number' && Number.isFinite(value)
  if (typeof value !== 'string' || /[\r\n]/.test(value))
    return false
  if (field.type === 'select') {
    return typeof field.options === 'string'
      && field.options.split(',').map(option => option.trim()).includes(value)
  }
  return field.type === 'string'
}

export function formSelectOptions(value: unknown): string | undefined {
  if (typeof value === 'string')
    return value.trim() || undefined
  if (!Array.isArray(value) || !value.length)
    return undefined
  const values = value.map(item => isRecord(item)
    ? item.value ?? item.key ?? item.label ?? item.name
    : item)
  // NodeGet uses a comma-delimited string and trims each option. Reject values
  // that cannot survive that encoding instead of changing their type or content.
  if (!values.every(item => typeof item === 'string' && item.length > 0
    && item === item.trim() && !/[,\r\n]/.test(item))) {
    return undefined
  }
  return values.join(',')
}
