import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({plugins:[react()],resolve:{alias:{'@supabase/supabase-js':fileURLToPath(new URL('./supabase-mock.ts',import.meta.url))}},server:{host:'127.0.0.1',port:4178,strictPort:true,fs:{allow:[process.cwd()]}}});
