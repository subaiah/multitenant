#!/bin/bash

echo "🔍 Checking backend build errors..."
cd backend

echo ""
echo "📦 Checking if node_modules exists..."
if [ ! -d "node_modules" ]; then
    echo "❌ node_modules not found. Please run: npm install"
    exit 1
fi

echo "✅ node_modules exists"

echo ""
echo "🔧 Checking Prisma client..."
if [ ! -d "node_modules/@prisma/client" ]; then
    echo "❌ Prisma client not found. Running: npx prisma generate"
    npx prisma generate
fi

echo ""
echo "🏗️  Running TypeScript build..."
npm run build 2>&1 | tee /tmp/build_errors.txt

echo ""
echo "📊 Build completed. Checking for errors..."

if grep -q "error TS" /tmp/build_errors.txt; then
    echo "❌ Build failed with TypeScript errors"
    echo ""
    echo "📝 Error summary:"
    grep "error TS" /tmp/build_errors.txt | wc -l | xargs echo "Total errors:"
    echo ""
    echo "🔍 First 20 errors:"
    grep "error TS" /tmp/build_errors.txt | head -20
else
    echo "✅ Build successful! No TypeScript errors."
fi
