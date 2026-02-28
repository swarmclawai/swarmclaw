import path from 'path'

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
