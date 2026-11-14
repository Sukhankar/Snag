import {cpSync,mkdirSync,rmSync} from 'node:fs';
rmSync('dist',{recursive:true,force:true});mkdirSync('dist');cpSync('src','dist',{recursive:true});
