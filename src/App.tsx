import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Upload, 
  FileImage, 
  CheckCircle2, 
  Loader2, 
  Download, 
  X, 
  ChevronRight, 
  Search,
  FolderOpen,
  AlertCircle,
  Plus,
  Users,
  Calendar,
  Layers,
  ArrowLeft,
  Printer,
  CloudUpload,
  Trash2,
  FileText
} from 'lucide-react';
import JSZip from 'jszip';
import { CATEGORIES, Category } from './constants';
import { classifyImage } from './services/classifier';
import { cn } from './lib/utils';
import { Teacher, FileState, OperationStatus } from './types';

const sanitizeName = (name: string) => {
  if (!name) return 'unnamed';
  let clean = name.replace(/[\\\\\\/\\:\\*\\?"\\<\\>\\|\\r\\n\\t\\0]/g, '-');
  clean = clean.trim().replace(/[\\. ]+$/, '');
  if (!clean || clean === '.' || clean === '..') return 'unnamed';
  return clean;
};

interface AnalyzeReport {
  teacher: Teacher;
  reportData: {
    category: Category;
    subItems: { name: string; hasFiles: boolean; fileCount: number }[];
  }[];
}

export default function App() {
  const [teachers, setTeachers] = useState<Teacher[]>(() => {
    const saved = localStorage.getItem('teachers');
    return saved ? JSON.parse(saved) : [];
  });
  
  const [selectedTeacher, setSelectedTeacher] = useState<Teacher | null>(null);
  const [showAddTeacher, setShowAddTeacher] = useState(false);
  const [newTeacherName, setNewTeacherName] = useState('');
  
  const [files, setFiles] = useState<FileState[]>([]);
  const [currentStep, setCurrentStep] = useState<'selection' | 'upload' | 'processing' | 'results' | 'analysis_report'>('selection');
  const [analyzeReport, setAnalyzeReport] = useState<AnalyzeReport | null>(null);
  
  const [isSavingLocal, setIsSavingLocal] = useState(false);
  const [centralDirHandle, setCentralDirHandle] = useState<any>(null);

  const [dropboxToken, setDropboxToken] = useState<string | null>(() => localStorage.getItem('dropboxToken'));

  useEffect(() => {
    if (dropboxToken) {
      localStorage.setItem('dropboxToken', dropboxToken);
    } else {
      localStorage.removeItem('dropboxToken');
    }
  }, [dropboxToken]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS' && event.data.provider === 'dropbox') {
        setDropboxToken(event.data.token);
        alert('تم الارتباط بحساب Dropbox بنجاح!');
      } else if (event.data?.type === 'OAUTH_AUTH_ERROR') {
        alert('فشل الارتباط: ' + event.data.error);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const connectDropbox = async () => {
    try {
      const response = await fetch('/api/auth/dropbox/url');
      if (!response.ok) throw new Error('Failed to get auth URL');
      const { url } = await response.json();
      const authWindow = window.open(url, 'oauth_popup', 'width=600,height=700');
      if (!authWindow) {
        alert('يرجى السماح بالنوافذ المنبثقة (Popups) للارتباط بـ Dropbox.');
      }
    } catch (err: any) {
      alert('حدث خطأ أثناء طلب الربط.');
    }
  };

  useEffect(() => {
    localStorage.setItem('teachers', JSON.stringify(teachers));
  }, [teachers]);

  const saveToLocalFolder = async () => {
    if (!selectedTeacher || files.length === 0) return;
    
    try {
      setIsSavingLocal(true);

      let dirHandle = centralDirHandle;

      if (!dirHandle) {
        // file picker APIs do not work in cross-origin iframes
        try {
          if (window.self !== window.top) {
            alert('عذراً، ميزة حفظ المجلدات غير مدعومة داخل نافذة العرض (iframe). يرجى فتح التطبيق في علامة تبويب جديدة للاستفادة من هذه الميزة.');
            setIsSavingLocal(false);
            return;
          }
        } catch (e) {
          alert('عذراً، ميزة حفظ المجلدات غير مدعومة داخل نافذة العرض (iframe). يرجى فتح التطبيق في علامة تبويب جديدة للاستفادة من هذه الميزة.');
          setIsSavingLocal(false);
          return;
        }

        if (!('showDirectoryPicker' in window)) {
          alert('متصفحك لا يدعم هذه الميزة. يرجى استخدام متصفح كـ Chrome.');
          return;
        }

        dirHandle = await (window as any).showDirectoryPicker({
          mode: 'readwrite',
          startIn: 'desktop'
        });
        setCentralDirHandle(dirHandle);
      }

      // Verify permission just in case
      if ((await dirHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
          const permission = await dirHandle.requestPermission({ mode: 'readwrite' });
          if (permission !== 'granted') {
              throw new Error('Permission not granted');
          }
      }

      const teacherDirHandle = await dirHandle.getDirectoryHandle(sanitizeName(selectedTeacher.name), { create: true });

      for (const category of CATEGORIES) {
        const categoryFiles = files.filter(f => f.tags?.some(tag => tag.categoryId === category.id));
        const safeCategoryName = sanitizeName(category.name);
        
        if (categoryFiles.length > 0) {
          const catDirHandle = await teacherDirHandle.getDirectoryHandle(safeCategoryName, { create: true });
          const nameTracker: Record<string, number> = {};

          for (const f of categoryFiles) {
            const relevantTags = f.tags?.filter(tag => tag.categoryId === category.id) || [];
            for (const tag of relevantTags) {
              const validSubName = category.subCategories.find(sub => sub === tag.subCategoryName);
              const subName = validSubName || category.subCategories[0];
              const safeSubName = sanitizeName(subName);
              
              const subDirHandle = await catDirHandle.getDirectoryHandle(safeSubName, { create: true });
              
              const parts = f.file.name.split('.');
              const extension = parts.length > 1 ? parts.pop() : 'png';
              let baseName = f.suggestedTitle ? sanitizeName(f.suggestedTitle) : sanitizeName(parts.join('.'));
              
              const key = `${safeSubName}/${baseName}`;
              if (nameTracker[key]) {
                nameTracker[key]++;
                baseName = `${baseName} (${nameTracker[key]})`;
              } else {
                nameTracker[key] = 1;
              }
              const safeFileName = `${baseName}.${extension}`;
              
              const fileHandle = await subDirHandle.getFileHandle(safeFileName, { create: true });
              const writable = await fileHandle.createWritable();
              await writable.write(f.file);
              await writable.close();
            }
          }
        } else {
          await teacherDirHandle.getDirectoryHandle(safeCategoryName, { create: true });
        }
      }

      alert('تم الحفظ في المجلد بنجاح!');
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error(err);
        alert(`حدث خطأ أثناء الحفظ: ${err.message || 'خطأ غير معروف'}`);
      }
    } finally {
      setIsSavingLocal(false);
    }
  };

  const saveToDropbox = async () => {
    if (!selectedTeacher || files.length === 0 || !dropboxToken) return;

    try {
      setIsSavingLocal(true);

      const basePath = `/سجلات الأداء/${sanitizeName(selectedTeacher.name)}`;
      
      // Create teacher folder
      await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${dropboxToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: basePath, autorename: false })
      }).catch(e => console.log('Folder exists or error', e));

      for (const category of CATEGORIES) {
        const categoryFiles = files.filter(f => f.tags?.some(tag => tag.categoryId === category.id));
        const safeCategoryName = sanitizeName(category.name);
        
        const catPath = `${basePath}/${safeCategoryName}`;

        if (categoryFiles.length > 0) {
          await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${dropboxToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: catPath, autorename: false })
          }).catch(e => {});

          const nameTracker: Record<string, number> = {};

          for (const f of categoryFiles) {
            const relevantTags = f.tags?.filter(tag => tag.categoryId === category.id) || [];
            for (const tag of relevantTags) {
              const validSubName = category.subCategories.find(sub => sub === tag.subCategoryName);
              const subName = validSubName || category.subCategories[0];
              const safeSubName = sanitizeName(subName);
              
              const subPath = `${catPath}/${safeSubName}`;
              await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${dropboxToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: subPath, autorename: false })
              }).catch(e => {});
              
              const parts = f.file.name.split('.');
              const extension = parts.length > 1 ? parts.pop() : 'png';
              let baseName = f.suggestedTitle ? sanitizeName(f.suggestedTitle) : sanitizeName(parts.join('.'));
              
              const key = `${safeSubName}/${baseName}`;
              if (nameTracker[key]) {
                nameTracker[key]++;
                baseName = `${baseName} (${nameTracker[key]})`;
              } else {
                nameTracker[key] = 1;
              }
              const safeFileName = `${baseName}.${extension}`;
              
              const filePath = `${subPath}/${safeFileName}`;

              const fileArg = {
                path: filePath,
                mode: 'add',
                autorename: true,
                mute: false
              };

              await fetch('https://content.dropboxapi.com/2/files/upload', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${dropboxToken}`,
                  'Dropbox-API-Arg': JSON.stringify(fileArg),
                  'Content-Type': 'application/octet-stream'
                },
                body: f.file
              });
            }
          }
        } else {
          await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${dropboxToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: catPath, autorename: false })
          }).catch(e => {});
        }
      }

      alert('تم الحفظ في Dropbox بنجاح!');
    } catch (err: any) {
      if (err.message?.includes('401')) {
        setDropboxToken(null);
        alert('جلسة Dropbox منتهية. يرجى تسجيل الدخول مجدداً.');
      } else {
        console.error(err);
        alert(`حدث خطأ أثناء الحفظ: ${err.message || 'خطأ غير معروف'}`);
      }
    } finally {
      setIsSavingLocal(false);
    }
  };

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const newFiles = acceptedFiles.map(file => ({
      id: Math.random().toString(36).substring(7),
      file,
      preview: URL.createObjectURL(file),
      status: OperationStatus.PENDING
    }));
    setFiles(prev => [...prev, ...newFiles]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 
      'image/*': [],
      'application/pdf': ['.pdf']
    },
    multiple: true
  } as any);

  const addTeacher = async () => {
    if (!newTeacherName.trim()) return;
    const tName = newTeacherName.trim();
    
    try {
      if (window.self !== window.top) {
        alert('ميزة إنشاء المجلدات غير مدعومة داخل (iframe). يرجى فتح التطبيق في علامة تبويب جديدة.');
        return;
      }
      
      let dirHandle = centralDirHandle;
      if (!dirHandle) {
        if (!('showDirectoryPicker' in window)) {
          alert('متصفحك لا يدعم الميزة.');
          return;
        }
        dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite', startIn: 'desktop' });
        setCentralDirHandle(dirHandle);
      }
      
      // Verify permission just in case
      if ((await dirHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
          const permission = await dirHandle.requestPermission({ mode: 'readwrite' });
          if (permission !== 'granted') {
              throw new Error('تم رفض الصلاحية');
          }
      }
      
      const teacherDirHandle = await dirHandle.getDirectoryHandle(sanitizeName(tName), { create: true });
      for (const category of CATEGORIES) {
        const catDirHandle = await teacherDirHandle.getDirectoryHandle(sanitizeName(category.name), { create: true });
        for (const sub of category.subCategories) {
          await catDirHandle.getDirectoryHandle(sanitizeName(sub), { create: true });
        }
      }

      const teacher: Teacher = {
        id: Math.random().toString(36).substring(7),
        name: tName,
        foldersCount: CATEGORIES.length,
        lastUpdated: new Date().toLocaleDateString('ar-SA')
      };
      setTeachers(prev => [teacher, ...prev]);
      setNewTeacherName('');
      setShowAddTeacher(false);
      
      alert(`تم إنشاء ملفات المعلم ${tName} بنجاح في المجلد المركزي.`);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        alert(`حدث خطأ أثناء إنشاء مجلدات المعلم: ${err.message || 'خطأ غير معروف'}`);
      }
    }
  };

  const analyzeTeacherFolder = async (teacher: Teacher) => {
    try {
      if (window.self !== window.top) {
         alert('ميزة قراءة المجلدات غير مدعومة داخل نافذة العرض (iframe). يرجى فتح التطبيق في علامة تبويب جديدة.');
         return;
      }

      let dirHandle = centralDirHandle;
      if (!dirHandle) {
        if (!('showDirectoryPicker' in window)) {
          alert('متصفحك لا يدعم الميزة.');
          return;
        }
        dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite', startIn: 'desktop' });
        setCentralDirHandle(dirHandle);
      }
      
      // Verify permission just in case
      if ((await dirHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
          const permission = await dirHandle.requestPermission({ mode: 'readwrite' });
          if (permission !== 'granted') {
              throw new Error('تم رفض الصلاحية');
          }
      }
      
      let teacherDirHandle;
      try {
        teacherDirHandle = await dirHandle.getDirectoryHandle(sanitizeName(teacher.name), { create: false });
      } catch (e) {
        console.warn('Teacher folder not found', e);
      }
      
      if (!teacherDirHandle) {
        alert('لم يتم العثور على مجلد المعلم. يرجى التأكد من إنشائه.');
        return;
      }
      
      const reportData = [];
      for (const category of CATEGORIES) {
        let catDirHandle;
        try {
          catDirHandle = await teacherDirHandle.getDirectoryHandle(sanitizeName(category.name), { create: false });
        } catch (e) {}
        
        const subItems = [];
        for (const sub of category.subCategories) {
          let hasFiles = false;
          let fileCount = 0;
          if (catDirHandle) {
            let subDirHandle;
            try {
              subDirHandle = await catDirHandle.getDirectoryHandle(sanitizeName(sub), { create: false });
              for await (const [name, handle] of (subDirHandle as any).entries()) {
                if (handle.kind === 'file' && name !== '.DS_Store') {
                  hasFiles = true;
                  fileCount++;
                }
              }
            } catch (e) {}
          }
          subItems.push({ name: sub, hasFiles, fileCount });
        }
        reportData.push({ category, subItems });
      }
      
      setAnalyzeReport({ teacher, reportData });
      setCurrentStep('analysis_report');
    } catch (err: any) {
      if (err.name !== 'AbortError') {
         alert(`حدث خطأ أثناء تحليل المجلد: ${err.message}`);
      }
    }
  };

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const deleteTeacher = (id: string) => {
    if (confirm('هل أنت متأكد من حذف هذا المعلم وجميع بياناته من القائمة؟')) {
      setTeachers(prev => prev.filter(t => t.id !== id));
      if (selectedTeacher?.id === id) {
        setSelectedTeacher(null);
        setCurrentStep('selection');
      }
    }
  };

  const processFiles = async () => {
    if (files.length === 0) return;
    setCurrentStep('processing');

    const updatedFiles = [...files];
    
    for (let i = 0; i < updatedFiles.length; i++) {
      const fileState = updatedFiles[i];
      if (fileState.status === OperationStatus.COMPLETED) continue;

      try {
        updatedFiles[i] = { ...fileState, status: OperationStatus.PROCESSING };
        setFiles([...updatedFiles]);

        const reader = new FileReader();
        const base64Promise = new Promise<string>((resolve) => {
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(fileState.file);
        });
        
        const base64 = await base64Promise;
        const result = await classifyImage(base64, fileState.file.type);
        
        updatedFiles[i] = { 
          ...fileState, 
          status: OperationStatus.COMPLETED, 
          tags: result.classifications,
          suggestedTitle: result.suggestedTitle,
          base64: base64
        };
        setFiles([...updatedFiles]);
      } catch (error: any) {
        updatedFiles[i] = { ...fileState, status: OperationStatus.ERROR, errorMessage: error.message };
        setFiles([...updatedFiles]);
      }
    }

    setCurrentStep('results');
  };

  const downloadZip = async () => {
    if (!selectedTeacher) return;
    const zip = new JSZip();
    const teacherFolder = zip.folder(selectedTeacher.name);
    
    CATEGORIES.forEach(category => {
      const categoryFiles = files.filter(f => f.tags?.some(tag => tag.categoryId === category.id));
      if (categoryFiles.length > 0) {
        const catFolder = teacherFolder?.folder(category.name);
        const nameTracker: Record<string, number> = {};
        
        categoryFiles.forEach(f => {
          const relevantTags = f.tags?.filter(tag => tag.categoryId === category.id) || [];
          relevantTags.forEach(tag => {
            const validSubName = category.subCategories.find(sub => sub === tag.subCategoryName);
            const subName = validSubName || category.subCategories[0];
            const subFolder = catFolder?.folder(subName);
            const parts = f.file.name.split('.');
            const extension = parts.length > 1 ? parts.pop() : 'png';
            
            let baseName = f.suggestedTitle ? sanitizeName(f.suggestedTitle) : sanitizeName(parts.join('.'));
            
            const key = `${subName}/${baseName}`;
            if (nameTracker[key]) {
              nameTracker[key]++;
              baseName = `${baseName} (${nameTracker[key]})`;
            } else {
              nameTracker[key] = 1;
            }
            
            const safeFileName = `${baseName}.${extension}`;
            subFolder?.file(safeFileName, f.file);
          });
        });
      } else {
        teacherFolder?.folder(category.name); // Create empty folder anyway as per hierarchy
      }
    });

    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${selectedTeacher.name}_مجلدات_الأداء_${new Date().toISOString().split('T')[0]}.zip`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    window.print();
  };

  const stats = useMemo(() => {
    const errorCount = files.filter(f => f.status === OperationStatus.ERROR).length;
    return {
      total: files.length,
      completed: files.filter(f => f.status === OperationStatus.COMPLETED).length,
      errorCount,
      processing: files.filter(f => f.status === OperationStatus.PROCESSING).length,
      pending: files.filter(f => f.status === OperationStatus.PENDING).length,
      processedTotal: files.filter(f => f.status === OperationStatus.COMPLETED || f.status === OperationStatus.ERROR).length
    };
  }, [files]);

  const groupedResults = useMemo(() => {
    return CATEGORIES.map(cat => ({
      ...cat,
      files: files.filter(f => f.tags?.some(tag => tag.categoryId === cat.id))
    }));
  }, [files]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans p-4 md:p-8 overflow-x-hidden selection:bg-indigo-500/30" dir="rtl">
      {/* Header Bento Block */}
      <motion.div 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center mb-8 gap-4"
      >
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center font-bold text-3xl shadow-lg shadow-indigo-500/20">ك</div>
          <h1 className="text-2xl font-bold tracking-tight italic">كُلّ عَميلي <span className="text-zinc-500 font-normal">/ فارز الشواهد الذكي</span></h1>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={async () => {
              try {
                if (window.self !== window.top) {
                  alert('ميزة اختيار المجلدات غير مدعومة داخل نافذة العرض (iframe). يرجى فتح التطبيق في علامة تبويب جديدة.');
                  return;
                }
              } catch (e) {
                alert('ميزة اختيار المجلدات غير مدعومة داخل نافذة العرض (iframe). يرجى فتح التطبيق في علامة تبويب جديدة.');
                return;
              }

              if (!('showDirectoryPicker' in window)) {
                alert('متصفحك لا يدعم الميزة.');
                return;
              }
              try {
                const handle = await (window as any).showDirectoryPicker({ 
                  mode: 'readwrite',
                  startIn: 'desktop'
                });
                setCentralDirHandle(handle);
              } catch (e: any) {
                if (e.name !== 'AbortError') console.error(e);
              }
            }}
            className={cn(
              "flex items-center gap-2 border text-sm px-4 py-2 rounded-xl transition-all shadow-sm",
              centralDirHandle 
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
                : "bg-zinc-900 border-zinc-800 hover:bg-zinc-800 text-zinc-300"
            )}
          >
            <FolderOpen className="w-4 h-4" />
            <span className="hidden sm:inline font-medium">
               {centralDirHandle ? `مجلد الحفظ: ${centralDirHandle.name}` : 'تحديد مجلد الحفظ المركزي'}
            </span>
          </button>
          
          <div className="text-right hidden md:block">
            <p className="text-sm font-medium">{new Date().toLocaleDateString('ar-SA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
            <p className="text-xs text-zinc-500">{teachers.length} معلمين مسجلين</p>
          </div>
          <div className="w-10 h-10 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <Users className="w-5 h-5 text-zinc-400" />
          </div>
        </div>
      </motion.div>

      <main className="max-w-7xl mx-auto">
        <AnimatePresence mode="wait">
          {currentStep === 'selection' && (
            <motion.div
              key="selection"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="grid grid-cols-1 md:grid-cols-4 gap-4 min-h-[500px]"
            >
              {/* Main Welcome & Add Teacher Bento */}
              <div className="md:col-span-2 md:row-span-2 bg-zinc-900 border border-zinc-800 rounded-[2.5rem] p-10 flex flex-col justify-between relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-600/10 blur-[100px] rounded-full -mr-20 -mt-20 group-hover:bg-indigo-600/20 transition-colors" />
                <div>
                  <span className="px-3 py-1 bg-indigo-500/10 text-indigo-400 text-xs font-bold rounded-full border border-indigo-500/20 uppercase tracking-widest">إدارة المعلمين</span>
                  <h2 className="text-5xl font-light mt-8 leading-tight">ابدأ بتنظيم<br/><span className="font-bold text-indigo-500">ملفاتك المهنية</span></h2>
                  <p className="text-zinc-400 mt-6 max-w-sm text-lg leading-relaxed">قم بإضافة معلم جديد أو اختر من القائمة لبدء فرز وتصنيف شواهد الأداء الوظيفي آلياً.</p>
                </div>
                
                <div className="mt-12">
                  {!showAddTeacher ? (
                    <button 
                      onClick={() => setShowAddTeacher(true)}
                      className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-4 rounded-2xl font-bold flex items-center gap-3 transition-all active:scale-95 shadow-xl shadow-indigo-600/20"
                    >
                      <Plus className="w-6 h-6" />
                      إضافة معلم جديد
                    </button>
                  ) : (
                    <motion.div 
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex gap-3"
                    >
                      <input 
                        autoFocus
                        type="text"
                        placeholder="اسم المعلم..."
                        className="bg-zinc-800 border border-zinc-700 rounded-2xl px-6 py-4 flex-1 text-white placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500 transition-colors"
                        value={newTeacherName}
                        onChange={(e) => setNewTeacherName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addTeacher()}
                      />
                      <button 
                        onClick={addTeacher}
                        className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 rounded-2xl font-bold transition-all"
                      >
                        حفظ
                      </button>
                      <button 
                        onClick={() => setShowAddTeacher(false)}
                        className="bg-zinc-800 hover:bg-zinc-700 text-zinc-400 px-4 rounded-2xl transition-all"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </motion.div>
                  )}
                </div>
              </div>

              {/* Teachers List Bento */}
              <div className="md:col-span-2 md:row-span-2 bg-zinc-900/50 border border-zinc-800 rounded-[2.5rem] p-8 flex flex-col">
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-xs text-zinc-500 uppercase tracking-[0.2em] font-bold">المعلمين المسجلين</h3>
                  <Users className="w-4 h-4 text-zinc-500" />
                </div>
                
                <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin">
                  {teachers.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center opacity-50 space-y-4">
                      <div className="w-16 h-16 rounded-full border-2 border-dashed border-zinc-700 flex items-center justify-center">
                        <Users className="w-8 h-8 text-zinc-700" />
                      </div>
                      <p className="text-sm">لا يوجد معلمين مضافين حالياً</p>
                    </div>
                  ) : (
                    teachers.map((t, idx) => (
                      <motion.div
                        key={t.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.05 }}
                        className="bg-zinc-900 border border-zinc-800 p-5 rounded-3xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4 hover:border-indigo-600/50 hover:bg-zinc-800/50 transition-all group"
                      >
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 rounded-2xl bg-zinc-800 flex items-center justify-center text-indigo-500 font-bold group-hover:bg-indigo-600 group-hover:text-white transition-colors uppercase">
                            {t.name.charAt(0)}
                          </div>
                          <div>
                            <p className="font-bold text-lg">{t.name}</p>
                            <p className="text-xs text-zinc-500 flex items-center gap-2 mt-1">
                              <Calendar className="w-3 h-3" />
                              {t.lastUpdated}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 self-end md:self-auto flex-wrap">
                          <button 
                            onClick={(e) => { e.stopPropagation(); deleteTeacher(t.id); }}
                            className="bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white px-4 py-3 md:py-2 rounded-xl text-xs font-bold transition-colors shadow-sm flex items-center gap-2"
                          >
                            <Trash2 className="w-4 h-4" />
                            حذف
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); analyzeTeacherFolder(t); }}
                            className="bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-white px-4 py-3 md:py-2 rounded-xl text-xs font-bold transition-colors shadow-sm flex items-center gap-2"
                          >
                            <Search className="w-4 h-4" />
                            تحليل المجلد
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); setSelectedTeacher(t); setCurrentStep('upload'); }}
                            className="bg-indigo-600/10 text-indigo-400 hover:bg-indigo-600 hover:text-white px-4 py-3 md:py-2 rounded-xl text-xs font-bold transition-colors shadow-sm flex items-center gap-2"
                          >
                            <Upload className="w-4 h-4" />
                            رفع الشواهد
                          </button>
                        </div>
                      </motion.div>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {currentStep === 'upload' && (
            <motion.div
              key="upload"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="grid grid-cols-1 md:grid-cols-4 md:grid-rows-3 gap-4 h-full md:h-[650px]"
            >
              {/* Teacher Info Card */}
              <div className="col-span-1 row-span-1 bg-zinc-900 border border-zinc-800 rounded-3xl p-6 flex flex-col justify-between">
                <div className="flex items-center gap-3 mb-4">
                  <button onClick={() => setCurrentStep('selection')} className="p-2 hover:bg-zinc-800 rounded-xl transition-colors">
                    <ArrowLeft className="w-5 h-5 text-indigo-500" />
                  </button>
                  <p className="text-xs text-zinc-500 uppercase tracking-widest font-bold">المعلم الحالي</p>
                </div>
                <div>
                  <p className="text-3xl font-bold leading-none mb-2">{selectedTeacher?.name}</p>
                  <p className="text-xs text-emerald-400">سيتم حفظ الملفات في المجلد المخصص</p>
                </div>
              </div>

              {/* Upload Master Box */}
              <div 
                {...getRootProps()}
                className={cn(
                  "col-span-2 row-span-2 rounded-[2.5rem] p-10 flex flex-col items-center justify-center text-center transition-all cursor-pointer border-2 border-dashed group",
                  isDragActive ? "border-indigo-500 bg-indigo-500/5" : "border-zinc-800 bg-zinc-900 hover:border-zinc-700 hover:bg-zinc-900/80"
                )}
              >
                <input {...getInputProps()} />
                <div className="w-24 h-24 bg-indigo-500/10 rounded-full flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <Upload className="w-10 h-10 text-indigo-500" />
                </div>
                <h3 className="text-2xl font-bold mb-2">اسحب وأفلت صور الشواهد</h3>
                <p className="text-zinc-500 max-w-xs mx-auto">ارفع جميع الصور والتقارير دفعة واحدة، وسيقوم الذكاء الاصطناعي بفرزها تلقائياً.</p>
                {files.length > 0 && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-6 flex items-center gap-2 px-6 py-2 bg-indigo-600 rounded-full text-sm font-bold shadow-lg shadow-indigo-600/20"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    {files.length} ملفات جاهزة
                  </motion.div>
                )}
              </div>

              {/* Action Sidebar */}
              <div className="col-span-1 row-span-2 bg-indigo-600 rounded-[2.5rem] p-8 text-white flex flex-col justify-between">
                <div>
                  <p className="text-xs uppercase tracking-widest font-bold opacity-80 mb-8 italic">نظرة سريعة</p>
                  <div className="space-y-6">
                    <div className="flex items-start gap-4">
                      <div className="w-8 h-8 rounded-xl bg-white/20 flex items-center justify-center font-bold text-lg">1</div>
                      <div>
                        <p className="font-bold text-sm">رفع الملفات</p>
                        <p className="text-xs opacity-70">صور أو لقطات شاشة</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-4">
                      <div className="w-8 h-8 rounded-xl bg-white/20 flex items-center justify-center font-bold text-lg">2</div>
                      <div>
                        <p className="font-bold text-sm">الفرز الذكي</p>
                        <p className="text-xs opacity-70">تصنيف آلي للبنود الـ 11</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-4">
                      <div className="w-8 h-8 rounded-xl bg-white/20 flex items-center justify-center font-bold text-lg">3</div>
                      <div>
                        <p className="font-bold text-sm">تحميل التقرير</p>
                        <p className="text-xs opacity-70">مجلدات منظمة ZIP</p>
                      </div>
                    </div>
                  </div>
                </div>

                <button 
                  disabled={files.length === 0}
                  onClick={processFiles}
                  className="w-full bg-white text-indigo-600 py-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-zinc-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-xl shadow-black/10"
                >
                  بدء التحليل <ChevronRight className="w-5 h-5" />
                </button>
              </div>

              {/* Status/Counter Bento */}
              <div className="col-span-1 row-span-1 bg-zinc-900 border border-zinc-800 rounded-3xl p-6 flex flex-col justify-between overflow-hidden relative group">
                <div className="absolute -right-4 -bottom-4 w-24 h-24 bg-emerald-500/10 rounded-full blur-2xl group-hover:bg-emerald-500/20 transition-colors" />
                <p className="text-xs text-zinc-500 uppercase tracking-widest font-bold">بنية المجلدات</p>
                <div className="flex items-end gap-3">
                  <p className="text-4xl font-bold">11</p>
                  <p className="text-xs text-emerald-400 mb-1">مجلدات رئيسية</p>
                </div>
              </div>

              {/* File Previews Bento */}
              <div className="col-span-2 row-span-1 bg-zinc-900 border border-zinc-800 rounded-3xl p-6 overflow-hidden flex flex-col">
                <div className="flex justify-between items-center mb-4">
                  <p className="text-xs text-zinc-500 uppercase tracking-widest font-bold">معاينة الملفات</p>
                  <span onClick={() => setFiles([])} className="text-xs text-indigo-400 cursor-pointer hover:underline">إفراغ القائمة</span>
                </div>
                <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-thin">
                  {files.length === 0 ? (
                    <div className="w-full h-full flex items-center justify-center text-zinc-600 text-xs italic">لا توجد ملفات حالياً</div>
                  ) : (
                    files.map(f => (
                      <div key={f.id} className="relative shrink-0 w-20 h-20 rounded-xl overflow-hidden border border-zinc-800">
                        {f.file.type.startsWith('image/') ? (
                          <img src={f.preview} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center bg-zinc-800/50 text-indigo-400">
                            <FileText className="w-6 h-6 mb-1" />
                            <span className="text-[9px] font-bold truncate px-1 max-w-full uppercase">{f.file.name.split('.').pop()}</span>
                          </div>
                        )}
                        <button 
                          onClick={(e) => { e.stopPropagation(); removeFile(f.id); }}
                          className="absolute top-1 right-1 bg-zinc-950/80 rounded-lg p-1 text-white hover:bg-red-500"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {currentStep === 'processing' && (
            <motion.div
              key="processing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="max-w-4xl mx-auto py-20 text-center space-y-12"
            >
              <div className="relative inline-block">
                <div className="w-32 h-32 rounded-full border-4 border-zinc-800 border-t-indigo-600 animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center flex-col">
                  <span className="text-2xl font-bold">{Math.round((stats.processedTotal / (stats.total || 1)) * 100)}%</span>
                </div>
              </div>
              
              <div className="space-y-4">
                <h2 className="text-4xl font-bold tracking-tight">جاري تحليل وفرز شواهد {selectedTeacher?.name}</h2>
                <p className="text-zinc-500 text-lg max-w-lg mx-auto">يقوم وكيل الذكاء الاصطناعي الآن بقراءة محتوى كل صورة ومطابقتها مع معايير الأداء الوظيفي الجديدة.</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-6 max-w-4xl mx-auto">
                <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-3xl">
                  <p className="text-xs text-zinc-500 uppercase font-bold mb-2">الإجمالي</p>
                  <p className="text-3xl font-bold">{stats.total}</p>
                </div>
                <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-3xl">
                  <p className="text-xs text-zinc-500 uppercase font-bold mb-2">قيد المعالجة</p>
                  <p className="text-3xl font-bold text-indigo-500">{stats.processing}</p>
                </div>
                <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-3xl">
                  <p className="text-xs text-zinc-500 uppercase font-bold mb-2">مكتمل</p>
                  <p className="text-3xl font-bold text-emerald-400">{stats.completed}</p>
                </div>
                <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-3xl">
                  <p className="text-xs text-zinc-500 uppercase font-bold mb-2">أخطاء</p>
                  <p className="text-3xl font-bold text-red-500">{stats.errorCount}</p>
                </div>
              </div>
            </motion.div>
          )}

          {currentStep === 'results' && (
            <motion.div
              key="results"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-8"
            >
              {/* Results Top Bento Grid */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {files.filter(f => f.status === OperationStatus.ERROR).length > 0 && (
                  <div className="md:col-span-4 bg-red-500/10 border border-red-500/20 rounded-[2.5rem] p-8 text-red-500 mb-4">
                    <h3 className="font-bold text-lg mb-2 flex items-center gap-2"><AlertCircle className="w-5 h-5"/> عذراً، حدثت مشكلة أثناء الفرز لبعض الملفات</h3>
                    <ul className="list-disc list-inside space-y-1">
                      {files.filter(f => f.status === OperationStatus.ERROR).map(f => (
                        <li key={f.id} className="text-sm">
                          {f.file.name}: {f.errorMessage || 'خطأ غير معروف'}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="md:col-span-2 bg-zinc-900 border border-zinc-800 rounded-[2.5rem] p-8 flex items-center justify-between overflow-hidden relative">
                   <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 blur-[50px] rounded-full" />
                   <div>
                    <h2 className="text-3xl font-bold mb-2">اكتمل الفرز بنجاح</h2>
                    <p className="text-zinc-500">تم تنظيم {stats.completed} شواهد في حقيبة {selectedTeacher?.name}.</p>
                   </div>
                   <div className="flex gap-3 flex-wrap justify-end">
                    <button 
                      disabled={isSavingLocal}
                      onClick={saveToLocalFolder}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-4 rounded-2xl font-bold flex items-center gap-2 transition-all shadow-xl shadow-emerald-600/10 disabled:opacity-50"
                    >
                      {isSavingLocal ? (
                         <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                         <FolderOpen className="w-5 h-5" />
                      )}
                      حفظ محلي (كمبيوتر)
                    </button>
                    {dropboxToken ? (
                      <button 
                        disabled={isSavingLocal}
                        onClick={saveToDropbox}
                        className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-4 rounded-2xl font-bold flex items-center gap-2 transition-all shadow-xl shadow-blue-600/10 disabled:opacity-50"
                      >
                        {isSavingLocal ? (
                           <Loader2 className="w-5 h-5 animate-spin" />
                        ) : (
                           <CloudUpload className="w-5 h-5" />
                        )}
                        حفظ إلى Dropbox
                      </button>
                    ) : (
                      <button 
                        onClick={connectDropbox}
                        className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-4 rounded-2xl font-bold flex items-center gap-2 transition-all shadow-xl shadow-blue-600/10"
                      >
                         <CloudUpload className="w-5 h-5" />
                        اربط حساب Dropbox
                      </button>
                    )}
                    <button 
                      onClick={handlePrint}
                      className="p-4 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-2xl transition-all shadow-lg"
                      title="طباعة التقرير"
                    >
                      <Printer className="w-6 h-6" />
                    </button>
                    <button 
                      onClick={downloadZip}
                      className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-4 rounded-2xl font-bold flex items-center gap-2 transition-all shadow-xl shadow-indigo-600/10"
                    >
                      <Download className="w-5 h-5" />
                      تحميل الحقيبة
                    </button>
                   </div>
                </div>

                <div className="bg-zinc-900 border border-zinc-800 rounded-[2.5rem] p-8 flex flex-col justify-center text-center">
                  <p className="text-xs text-zinc-500 uppercase font-bold mb-2">نسبة تغطية المعايير</p>
                  <p className="text-4xl font-bold">{Math.round((groupedResults.filter(g => g.files.length > 0).length / 11) * 100)}%</p>
                  <p className="text-[10px] text-zinc-500 mt-2 italic">بناءً على الشواهد المرفقة</p>
                </div>

                <div 
                  onClick={() => { setCurrentStep('selection'); setFiles([]); }}
                  className="bg-zinc-100 hover:bg-white text-zinc-900 rounded-[2.5rem] p-8 flex flex-col items-center justify-center cursor-pointer transition-all"
                >
                  <div className="w-12 h-12 bg-zinc-900 rounded-full flex items-center justify-center text-white mb-3">
                    <Plus className="w-6 h-6" />
                  </div>
                  <span className="font-bold text-sm">فرز لمعلم آخر</span>
                </div>
              </div>

              {/* Detailed Report / Printing Area */}
              <div id="print-area" className="grid grid-cols-1 lg:grid-cols-3 gap-8 pt-4">
                <div className="lg:col-span-2 space-y-4">
                  <h3 className="text-sm text-zinc-500 font-bold uppercase tracking-widest flex items-center gap-2 px-2">
                    <Layers className="w-4 h-4" />
                    توزيع الشواهد على المجلدات
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {groupedResults.map((group, idx) => (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.05 }}
                        key={group.id}
                        className={cn(
                          "bg-zinc-900/50 border rounded-3xl overflow-hidden transition-all group",
                          group.files.length > 0 ? "border-emerald-500/20" : "border-zinc-800 opacity-60"
                        )}
                      >
                        <div className="p-5 border-b border-zinc-800 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="w-7 h-7 bg-zinc-800 text-zinc-400 group-hover:text-amber-400 transition-colors flex items-center justify-center rounded-lg text-[10px] font-bold border border-zinc-700">
                              {group.id}
                            </span>
                            <h4 className="font-bold text-sm leading-tight text-zinc-300">{group.name}</h4>
                          </div>
                          {group.files.length > 0 ? (
                            <span className="text-[10px] font-bold bg-emerald-500/10 text-emerald-400 px-2 py-1 rounded-lg border border-emerald-500/20">
                              {group.files.length} ملفات
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold bg-zinc-800 text-zinc-500 px-2 py-1 rounded-lg">فارغ</span>
                          )}
                        </div>
                        
                        <div className="p-4">
                          {group.files.length > 0 ? (
                            <div className="flex gap-2 flex-wrap">
                              {group.files.slice(0, 5).map(f => (
                                <div key={f.id} className="w-10 h-10 rounded-lg overflow-hidden border border-zinc-800 shrink-0">
                                  {f.file.type.startsWith('image/') ? (
                                    <img src={f.preview} alt="" className="w-full h-full object-cover" />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center bg-zinc-800/50 text-indigo-400">
                                      <FileText className="w-5 h-5" />
                                    </div>
                                  )}
                                </div>
                              ))}
                              {group.files.length > 5 && (
                                <div className="w-10 h-10 rounded-lg bg-zinc-800 flex items-center justify-center text-[10px] font-bold text-zinc-500 shrink-0">
                                  +{group.files.length - 5}
                                </div>
                              )}
                            </div>
                          ) : (
                            <p className="text-[10px] text-zinc-600 italic">لا توجد شواهد مصنفة لهذا البند</p>
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>

                {/* Gap Analysis / Missing Items */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-[2.5rem] p-8 h-fit sticky top-8">
                  <div className="flex items-center justify-between mb-8">
                    <h3 className="text-xl font-bold">تحليل النواقص</h3>
                    <AlertCircle className="w-5 h-5 text-amber-500" />
                  </div>
                  
                  <div className="space-y-6">
                    {CATEGORIES.map(category => {
                      const presentSubNames = files
                        .filter(f => f.tags?.some(tag => tag.categoryId === category.id))
                        .flatMap(f => f.tags?.filter(tag => tag.categoryId === category.id).map(tag => tag.subCategoryName) || []);
                      
                      const missingSubCategories = category.subCategories.filter(sc => 
                        !presentSubNames.some(name => name.includes(sc))
                      );

                      if (missingSubCategories.length === 0) return null;

                      return (
                        <div key={category.id} className="space-y-3">
                          <p className="text-xs font-bold text-zinc-500 uppercase tracking-widest">{category.name}</p>
                          <div className="space-y-1.5 px-1">
                            {missingSubCategories.slice(0, 2).map(sub => (
                              <div key={sub} className="flex items-center gap-2 text-[11px] text-zinc-400">
                                <div className="w-1 h-1 rounded-full bg-zinc-700" />
                                {sub}
                              </div>
                            ))}
                            {missingSubCategories.length > 2 && (
                                <p className="text-[10px] text-zinc-600 pr-3">+{missingSubCategories.length - 2} عناصر أخرى...</p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-10 p-5 bg-indigo-500/5 border border-indigo-500/10 rounded-2xl text-center">
                    <p className="text-xs text-indigo-400 font-bold mb-2">نصيحة مهنية</p>
                    <p className="text-[10px] text-zinc-400 leading-relaxed">بناءً على التحليل، يُنصح بإضافة شواهد متعلقة بـ "تبادل الزيارات" و "التقويم التكويني" لتعزيز ملفك المهني.</p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
          {currentStep === 'analysis_report' && analyzeReport && (
            <motion.div
              key="analysis_report"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="space-y-8"
            >
              <div className="flex items-center justify-between">
                 <div className="flex items-center gap-4">
                   <button onClick={() => setCurrentStep('selection')} className="p-2 hover:bg-zinc-800 rounded-xl transition-colors">
                      <ArrowLeft className="w-5 h-5 text-indigo-500" />
                   </button>
                   <div>
                     <h2 className="text-3xl font-bold">تقرير تحليل محتوى المجلد</h2>
                     <p className="text-zinc-500 mt-1">للمعلم: {analyzeReport.teacher.name}</p>
                   </div>
                 </div>
                 <div className="flex gap-3">
                   <button 
                      onClick={() => window.print()}
                      className="bg-indigo-600 text-white px-6 py-3 rounded-2xl font-bold flex items-center gap-2 hover:bg-indigo-500 transition-all shadow-xl"
                   >
                     <Printer className="w-5 h-5" />
                     طباعة التقرير (PDF)
                   </button>
                 </div>
              </div>

              <div id="print-area" className="bg-white text-black p-8 rounded-[2.5rem] print:rounded-none">
                 <div className="mb-8 border-b pb-4 hidden print:block">
                   <h1 className="text-2xl font-bold">تقرير إنجاز المعلم: {analyzeReport.teacher.name}</h1>
                   <p className="text-gray-500">{new Date().toLocaleDateString('ar-SA')}</p>
                 </div>

                 <div className="space-y-8">
                   {analyzeReport.reportData.map(data => {
                      const score = data.subItems.length > 0 
                        ? Math.round((data.subItems.filter(sub => sub.hasFiles).length / data.subItems.length) * 100)
                        : 0;
                      
                      return (
                        <div key={data.category.id} className="border rounded-2xl p-6">
                           <div className="flex justify-between items-center mb-4">
                             <h3 className="text-lg font-bold flex items-center gap-2">
                               <span className="w-6 h-6 bg-gray-100 rounded-lg flex items-center justify-center text-sm">{data.category.id}</span>
                               {data.category.name}
                             </h3>
                             <span className={cn("px-3 py-1 rounded-full text-xs font-bold", score === 100 ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-700")}>
                               {score}% مكتمل
                             </span>
                           </div>
                           
                           <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                             {data.subItems.map(sub => (
                               <div key={sub.name} className={cn("flex justify-between items-center p-3 rounded-xl border", sub.hasFiles ? "bg-green-50 border-green-100" : "bg-red-50 border-red-100")}>
                                 <span className={cn("text-sm", sub.hasFiles ? "text-green-800 font-medium" : "text-red-700")}>{sub.name}</span>
                                 <div className="flex items-center gap-2">
                                   {sub.hasFiles ? (
                                     <>
                                       <span className="text-xs text-green-600 bg-green-100 px-2 py-1 rounded-full">{sub.fileCount} ملف/ملفات</span>
                                       <CheckCircle2 className="w-5 h-5 text-green-500" />
                                     </>
                                   ) : (
                                     <>
                                       <span className="text-xs text-red-500 font-bold">ناقص</span>
                                       <AlertCircle className="w-5 h-5 text-red-400" />
                                     </>
                                   )}
                                 </div>
                               </div>
                             ))}
                           </div>
                        </div>
                      )
                   })}
                 </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      <footer className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center py-12 mt-20 border-t border-zinc-900 gap-4 text-center sm:text-right">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-6 h-6 bg-indigo-600 rounded-lg" />
            <span className="font-bold tracking-tight">كُلّ عَميلي</span>
          </div>
          <p className="text-[10px] text-zinc-500">نظام أتمتة ملفات الإنجاز مدعوم بـ AI لخدمة الميدان التعليمي.</p>
        </div>
        <div className="flex gap-8">
           <div className="text-center">
             <p className="text-[10px] text-zinc-500 uppercase font-bold mb-1">المطور</p>
             <p className="text-xs font-bold">بواسطة AI Studio</p>
           </div>
           <div className="text-center">
             <p className="text-[10px] text-zinc-500 uppercase font-bold mb-1">الإصدار</p>
             <p className="text-xs font-bold">1.2.0 - Bento Grid</p>
           </div>
        </div>
      </footer>

      {/* Print Styles */}
      <style>{`
        @media print {
          body { background: white !important; color: black !important; padding: 0 !important; }
          #print-area { grid-template-columns: 1fr !important; display: block !important; }
          .bg-zinc-900, .bg-zinc-950, .bg-zinc-900\\/50 { background: white !important; border: 1px solid #eee !important; color: black !important; }
          .text-zinc-100, .text-zinc-300, .text-zinc-400, .text-zinc-500 { color: black !important; }
          .shadow-lg, .shadow-xl, .shadow-md, .backdrop-blur-md { box-shadow: none !important; backdrop-filter: none !important; }
          button, footer, header { display: none !important; }
          .rounded-[2.5rem], .rounded-3xl, .rounded-2xl { border-radius: 8px !important; }
          .col-span-2, .lg\\:col-span-2 { width: 100% !important; margin-bottom: 2rem !important; }
          @page { margin: 2cm; }
        }
      `}</style>
    </div>
  );
}
