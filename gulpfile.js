const gulp = require('gulp')
const minifycss = require('gulp-clean-css')
const uglify = require('gulp-uglify')
const htmlmin = require('gulp-htmlmin')
const cssnano = require('gulp-cssnano')
const htmlclean = require('gulp-htmlclean')
const del = require('del')
const babel = require('gulp-babel')
const autoprefixer = require('gulp-autoprefixer')
const connect = require('gulp-connect')
const pug = require('gulp-pug')
const less = require('gulp-less')
const express = require('express')
const path = require('path');


const config = require('./config.json')

gulp.task('clean', function () {
	return del(['./dist/css/', './dist/js/', './dist/blog/'])
})

gulp.task('css', function () {
	return gulp
		.src('./src/css/*.less')
		.pipe(less().on('error', function (err) {
			console.log(err);
			this.emit('end');
		}))
		.pipe(minifycss({compatibility: 'ie8'}))
		.pipe(autoprefixer({overrideBrowserslist: ['last 2 version']}))
		.pipe(cssnano({reduceIdents: false}))
		.pipe(gulp.dest('./dist/css'))
})

gulp.task('html', function () {
	return gulp
		.src('./dist/index.html')
		.pipe(htmlclean())
		.pipe(htmlmin())
		.pipe(gulp.dest('./dist'))
})

gulp.task('js', function () {
	return gulp
		.src('./src/js/*.js')
		.pipe(babel({presets: ['@babel/preset-env']}))
		.pipe(uglify())
		.pipe(gulp.dest('./dist/js'))
})

gulp.task('pug', function () {
	return gulp
		.src('./src/index.pug')
		.pipe(pug({data: config}))
		.pipe(gulp.dest('./dist'))
})

gulp.task('timer', function () {
	return gulp
		.src('./src/timer.html')
		.pipe(gulp.dest('./dist'))
})

gulp.task('assets', function () {
	return gulp
		.src(['./src/assets/**/*'])
		.pipe(gulp.dest('./dist/assets'));
})

gulp.task('blog', function () {
	return Promise.resolve()
		.then(require('./scripts/build-blog.js'))
		.then(function () {
			return gulp.src('./dist/blog/**/*.html').pipe(connect.reload())
		})
})

gulp.task('build', gulp.series('clean', 'assets', 'pug', 'css', 'js', 'html', 'timer', 'blog'))
gulp.task('default', gulp.series('build'))

gulp.task('watch', function () {
	gulp.watch('./src/components/*.pug', gulp.parallel('pug'))
	gulp.watch('./src/index.pug', gulp.parallel('pug'))
	gulp.watch('./src/css/**/*.scss', gulp.parallel(['css']))
	gulp.watch('./src/js/*.js', gulp.parallel(['js']))
	gulp.watch(['./src/blog/**/*'], gulp.series('blog'))
	connect.server({
		root: 'dist',
		livereload: true,
		port: 8080
	})
})

// gulp.task('serve', function () {
// 	const app = express();
// 	app.set('views', path.join(__dirname, 'dist'))
// 	app.use(express.static(path.join(__dirname, 'dist')));
// 	app.get('/', (req, res) => {
// 		res.render('index', config)
// 	})
// 	app.listen(80, () => console.log("Server listening on :80"))
// })
gulp.task('serve', function () {
    const app = express();

    const distPath = path.join(__dirname, 'dist');

    app.use(express.static(distPath));

    app.get('/', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
    });
		
	app.get('/timer', (req, res) => {
		res.sendFile(path.join(distPath, 'timer.html'));
	})

	app.get('/blog', (req, res) => {
		res.sendFile(path.join(distPath, 'blog', 'index.html'));
	})

    app.listen(80, () => console.log("Server listening on :80"));
});